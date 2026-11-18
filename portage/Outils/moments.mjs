/**
 * Étage 3a — « on cherche les meilleurs moments ».
 *
 * Fonction pure : des segments transcrits en entrée, des moments scorés en
 * sortie. Aucune dépendance base ou réseau, donc testable directement.
 *
 * Méthode :
 *   1. Fenêtres glissantes de segments consécutifs dont la durée tombe
 *      dans la fourchette voulue (par défaut 15–75 s).
 *   2. Chaque fenêtre est notée sur 8 critères (100 points au total),
 *      puis pénalisée (remplissage oral, logistique, fin tronquée).
 *   3. Suppression des chevauchements (non-maximum suppression) : deux
 *      moments qui se recouvrent à plus de 35 % sont concurrents, on ne
 *      garde que le meilleur.
 *
 * Chaque critère renvoie sa valeur brute et ses points : l'UI affiche le
 * détail, le monteur peut contester le score.
 */
import { clamp } from "./commun.mjs";
import { countMatches, dominantEmotion, extractFigures, extractKeywords, FILLERS, HOUSEKEEPING, normalize, STRONG_OPENERS, TURN_MARKERS, WEAK_OPENERS, } from "./lexique.mjs";
export const DETECTOR_VERSION = "heuristic-v1";
/** Pondération des critères, documentée pour pouvoir être ajustée sans fouiller le code. */
export const WEIGHTS = {
    opener: 18, // le clip tient-il debout dès la première seconde
    emotion: 16, // charge émotionnelle
    specificity: 14, // chiffres, faits concrets
    narrative: 12, // setup → retournement → chute
    standalone: 12, // compréhensible hors contexte
    density: 12, // débit utile
    length: 8, // durée dans la zone qui performe
    rhythm: 8, // respirations, pas de blancs morts
};
function textOf(segments) {
    return segments.map((s) => s.text.trim()).join(" ").replace(/\s+/g, " ").trim();
}
function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
}
function scoreOpener(first) {
    const norm = normalize(first);
    const strong = countMatches(norm, STRONG_OPENERS);
    const firstWord = norm.split(/[\s,]/)[0] ?? "";
    const weakStart = WEAK_OPENERS.some((w) => norm.startsWith(normalize(w) + " ") || firstWord === normalize(w));
    const isQuestion = /\?/.test(first);
    const hasFigure = extractFigures(first).length > 0;
    const isImperative = /^(arrête|oublie|imagine|regarde|écoute|prends|arrêtez|pense)/.test(norm);
    let pts = 4; // socle : une phrase existe
    if (strong > 0)
        pts += 7;
    if (isQuestion)
        pts += 4;
    if (hasFigure)
        pts += 3;
    if (isImperative)
        pts += 3;
    if (weakStart)
        pts -= 6;
    const note = weakStart
        ? "Démarre sur un mot de liaison : le clip devra être recoupé une phrase plus loin"
        : strong > 0
            ? "Ouverture auto-portante"
            : isQuestion
                ? "Ouvre sur une question"
                : "Ouverture correcte sans accroche marquée";
    return { points: clamp(pts, 0, WEIGHTS.opener), note };
}
export function detectMoments(segments, opts = {}) {
    const minSeconds = opts.minSeconds ?? 15;
    const maxSeconds = opts.maxSeconds ?? 75;
    const limit = opts.limit ?? 8;
    const overlapThreshold = opts.overlapThreshold ?? 0.35;
    const minScore = opts.minScore ?? 30;
    if (segments.length === 0)
        return [];
    const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
    const candidates = [];
    for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i; j < sorted.length; j += 1) {
            const window = sorted.slice(i, j + 1);
            const start = window[0].startSec;
            const end = window[window.length - 1].endSec;
            const duration = end - start;
            if (duration < minSeconds)
                continue;
            if (duration > maxSeconds)
                break; // fenêtres suivantes encore plus longues
            candidates.push(scoreWindow(window, start, end, duration));
        }
    }
    // Déduplication : on garde les meilleurs, on écarte ce qui se recouvre trop.
    const kept = [];
    for (const cand of candidates.sort((a, b) => b.score - a.score)) {
        if (cand.score < minScore)
            continue;
        const overlapsKept = kept.some((k) => overlapRatio(cand, k) > overlapThreshold);
        if (overlapsKept)
            continue;
        kept.push(cand);
        if (kept.length >= limit)
            break;
    }
    return kept.sort((a, b) => a.startSec - b.startSec);
}
function overlapRatio(a, b) {
    const inter = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
    const shortest = Math.min(a.durationSec, b.durationSec);
    return shortest <= 0 ? 0 : inter / shortest;
}
function scoreWindow(window, start, end, duration) {
    const transcript = textOf(window);
    const norm = normalize(transcript);
    const words = wordCount(transcript);
    const wps = words / Math.max(1, duration);
    // ── Critère 1 : ouverture ───────────────────────────────────
    const opener = scoreOpener(window[0].text.trim());
    // ── Critère 2 : charge émotionnelle ─────────────────────────
    const emo = dominantEmotion(transcript);
    const emotionPts = clamp(Math.round(emo.hits * 4.5), 0, WEIGHTS.emotion);
    // ── Critère 3 : spécificité ─────────────────────────────────
    const figures = extractFigures(transcript);
    const specificityPts = clamp(figures.length * 4, 0, WEIGHTS.specificity);
    // ── Critère 4 : arc narratif ────────────────────────────────
    const turns = countMatches(norm, TURN_MARKERS);
    const narrativePts = clamp(turns * 6, 0, WEIGHTS.narrative);
    // ── Critère 5 : autonomie hors contexte ─────────────────────
    const endsClean = /[.!?]$/.test(transcript);
    const pronounOpen = /^(il|elle|ils|elles|ça|c'|lui|leur|ce truc|ce point)\b/.test(norm);
    let standalonePts = WEIGHTS.standalone;
    if (!endsClean)
        standalonePts -= 5;
    if (pronounOpen)
        standalonePts -= 6;
    if (window.length === 1 && words < 18)
        standalonePts -= 3;
    // ── Critère 6 : densité utile (débit moins le remplissage) ──
    const fillerHits = countMatches(norm, FILLERS);
    const fillerRatio = fillerHits / Math.max(1, words / 10); // pour 10 mots
    const idealWps = 2.8;
    const densityPts = clamp(Math.round((1 - Math.min(1, Math.abs(wps - idealWps) / idealWps)) * WEIGHTS.density), 0, WEIGHTS.density);
    // ── Critère 7 : durée dans la zone qui performe ─────────────
    // 22–45 s : plein pot. En dehors, décroissance douce.
    const lengthPts = duration >= 22 && duration <= 45
        ? WEIGHTS.length
        : clamp(Math.round(WEIGHTS.length * (1 - Math.min(1, (duration < 22 ? 22 - duration : duration - 45) / 30))), 0, WEIGHTS.length);
    // ── Critère 8 : rythme (blancs internes) ────────────────────
    let longestGap = 0;
    for (let k = 1; k < window.length; k += 1) {
        longestGap = Math.max(longestGap, window[k].startSec - window[k - 1].endSec);
    }
    const rhythmPts = clamp(Math.round(WEIGHTS.rhythm * (1 - Math.min(1, longestGap / 2.5))), 0, WEIGHTS.rhythm);
    const criteria = [
        { key: "opener", label: "Ouverture accrocheuse", raw: window[0].text.trim().slice(0, 70), points: opener.points, max: WEIGHTS.opener, note: opener.note },
        { key: "emotion", label: "Charge émotionnelle", raw: emo.emotion ? `${emo.emotion} (${emo.hits})` : "neutre", points: emotionPts, max: WEIGHTS.emotion },
        { key: "specificity", label: "Faits et chiffres", raw: figures.slice(0, 4).join(", ") || "aucun", points: specificityPts, max: WEIGHTS.specificity },
        { key: "narrative", label: "Retournement narratif", raw: turns, points: narrativePts, max: WEIGHTS.narrative, note: turns === 0 ? "Pas de bascule détectée" : undefined },
        { key: "standalone", label: "Compréhensible seul", raw: endsClean ? "phrase complète" : "fin tronquée", points: clamp(standalonePts, 0, WEIGHTS.standalone), max: WEIGHTS.standalone },
        { key: "density", label: "Débit utile", raw: `${wps.toFixed(2)} mots/s`, points: densityPts, max: WEIGHTS.density },
        { key: "length", label: "Durée", raw: `${duration.toFixed(1)} s`, points: lengthPts, max: WEIGHTS.length, note: duration >= 22 && duration <= 45 ? "Zone idéale" : undefined },
        { key: "rhythm", label: "Rythme", raw: `blanc max ${longestGap.toFixed(2)} s`, points: rhythmPts, max: WEIGHTS.rhythm },
    ];
    // ── Pénalités ───────────────────────────────────────────────
    const houseHits = countMatches(norm, HOUSEKEEPING);
    const penalties = [
        {
            key: "housekeeping",
            label: "Passage logistique",
            raw: houseHits,
            points: -clamp(houseHits * 9, 0, 25),
            max: 0,
            note: houseHits > 0 ? "Intro, remerciements ou appel à l'abonnement" : undefined,
        },
        {
            key: "fillers",
            label: "Remplissage oral",
            raw: `${fillerHits} marqueur(s)`,
            points: -clamp(Math.round(fillerRatio * 4), 0, 12),
            max: 0,
        },
    ];
    const positive = criteria.reduce((s, c) => s + c.points, 0);
    const negative = penalties.reduce((s, c) => s + c.points, 0);
    const score = clamp(Math.round(positive + negative), 0, 100);
    const best = [...criteria].sort((a, b) => b.points / b.max - a.points / a.max)[0];
    const worst = [...criteria].sort((a, b) => a.points / a.max - b.points / b.max)[0];
    const rationale = houseHits > 0
        ? `Passage logistique (intro/outro) : à éviter en clip.`
        : `${best.label.toLowerCase()} au top${emo.emotion ? `, tonalité « ${emo.emotion} »` : ""}${figures.length ? `, appuyé sur ${figures.slice(0, 2).join(" et ")}` : ""}. Point faible : ${worst.label.toLowerCase()}.`;
    return {
        startSec: Number(start.toFixed(2)),
        endSec: Number(end.toFixed(2)),
        durationSec: Number(duration.toFixed(2)),
        score,
        criteria,
        penalties,
        transcript,
        keywords: extractKeywords(transcript),
        figures,
        emotion: emo.emotion,
        rationale,
        segmentIdx: window.map((s) => s.idx),
        detector: DETECTOR_VERSION,
    };
}
