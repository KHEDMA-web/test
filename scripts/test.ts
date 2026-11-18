/**
 * Tests de la logique métier : scoring, signature de webhook, charge utile
 * Metricool, contrôle qualité. Aucune dépendance base ou réseau.
 *
 *   npm test
 */
import crypto from "node:crypto";
import { scoreApplication, scoreClipper, matchClipperToRush } from "../src/lib/whop/recruiting";
import { verifyWhopWebhook, signPayload, WebhookVerificationError } from "../src/lib/whop/webhook";
import { detectMoments } from "../src/lib/pipeline/moments";
import { generateHeuristicHooks, scoreHook } from "../src/lib/pipeline/hooks";
import { buildSchedulePayload } from "../src/lib/metricool/client";
import { networkDataFor } from "../src/lib/metricool/publish";
import { qaCheck } from "../src/lib/pipeline/clips";
import { buildAss, chunkWords } from "../src/lib/render/ass";
import { toMetricoolLocal } from "../src/lib/utils";
import { MockTranscriptionProvider } from "../src/lib/transcription/mock";
import { extractTopics, extractNumericFigures } from "../src/lib/pipeline/lexicon";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error("test synchrone attendu");
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(`${name} → ${(err as Error).message}`);
    console.log(`  ✗ ${name} — ${(err as Error).message}`);
  }
}

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    failures.push(`${name} → ${(err as Error).message}`);
    console.log(`  ✗ ${name} — ${(err as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, msg?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(msg ?? `attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(actual)}`);
  }
}

async function main() {
  console.log("\n── Étage 1 · scoring des candidatures ──");

  check("un dossier solide passe au-dessus du seuil d'acceptation", () => {
    const r = scoreApplication({
      portfolioUrls: ["a", "b", "c", "d"],
      pastClipViews: 4_200_000,
      followerCount: 56_000,
      editingTools: ["CapCut", "Premiere Pro", "After Effects"],
      niches: ["business", "podcast"],
      membershipStatus: "active",
      membershipValid: true,
      demandNiches: ["business", "tech"],
    });
    assert(r.score >= 70, `score trop bas : ${r.score}`);
    eq(r.decision, "accept");
  });

  check("un dossier vide est écarté", () => {
    const r = scoreApplication({ portfolioUrls: [], membershipStatus: "past_due", membershipValid: false });
    assert(r.score < 45, `score trop haut : ${r.score}`);
    eq(r.decision, "reject");
  });

  check("le score reste borné à 100 et la somme des critères est cohérente", () => {
    const r = scoreApplication({
      portfolioUrls: Array(50).fill("x"),
      pastClipViews: 999_000_000,
      followerCount: 9_000_000,
      editingTools: ["Premiere Pro", "After Effects", "DaVinci Resolve", "Final Cut Pro"],
      niches: ["business"],
      membershipValid: true,
      membershipStatus: "active",
      demandNiches: ["business"],
    });
    assert(r.score <= 100, `score hors borne : ${r.score}`);
    const sum = r.components.reduce((s, c) => s + c.points, 0);
    assert(sum >= r.score, "la somme des critères doit porter le score");
    for (const c of r.components) assert(c.points <= c.max, `${c.key} dépasse son maximum`);
  });

  check("un faible volume de clips bride le taux de validation", () => {
    const few = scoreClipper({ clipsSubmitted: 2, clipsApproved: 2, clipsPublished: 2, totalViews: 1000, onTimeRate: 100, medianTurnaroundH: 5, lastClipAt: new Date() });
    const many = scoreClipper({ clipsSubmitted: 40, clipsApproved: 40, clipsPublished: 40, totalViews: 20_000, onTimeRate: 100, medianTurnaroundH: 5, lastClipAt: new Date() });
    const fewApproval = few.components.find((c) => c.key === "approval")!.points;
    const manyApproval = many.components.find((c) => c.key === "approval")!.points;
    assert(fewApproval < manyApproval, "un échantillon de 2 clips ne doit pas valoir 100 % de confiance");
  });

  check("un clipper saturé n'est pas proposé", () => {
    const m = matchClipperToRush({
      clipper: { id: "x", name: "Test", score: 90, tier: "ELITE", niches: ["business"], languages: ["fr"], openAssignments: 3, medianTurnaroundH: 4 },
      campaign: { targetNiches: ["business"], language: "fr" },
      capacity: 3,
    });
    eq(m.components.find((c) => c.key === "capacity")!.points, 0);
    assert(m.reason.includes("saturé"), "la raison doit expliquer la saturation");
  });

  console.log("\n── Étage 1 · webhook Whop (Standard Webhooks) ──");

  const secret = "ws_test_secret_abcdef0123456789";
  const body = JSON.stringify({ id: "msg_1", type: "membership.activated", data: { id: "mem_1", status: "active" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = signPayload(secret, "msg_1", ts, body);

  check("une signature valide est acceptée", () => {
    const env = verifyWhopWebhook({
      rawBody: body,
      headers: { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
      secret,
    });
    eq(env.type, "membership.activated");
  });

  check("un corps modifié après signature est rejeté", () => {
    let threw = false;
    try {
      verifyWhopWebhook({
        rawBody: body.replace("active", "canceled"),
        headers: { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": `v1,${sig}` },
        secret,
      });
    } catch (e) {
      threw = e instanceof WebhookVerificationError;
    }
    assert(threw, "la vérification aurait dû échouer");
  });

  check("un horodatage trop ancien est rejeté (anti-rejeu)", () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
    const oldSig = signPayload(secret, "msg_2", oldTs, body);
    let threw = false;
    try {
      verifyWhopWebhook({
        rawBody: body,
        headers: { "webhook-id": "msg_2", "webhook-timestamp": oldTs, "webhook-signature": `v1,${oldSig}` },
        secret,
      });
    } catch (e) {
      threw = (e as Error).message.includes("tolérance");
    }
    assert(threw, "un horodatage d'il y a une heure doit être refusé");
  });

  check("plusieurs signatures (rotation de secret) : une seule valide suffit", () => {
    const other = crypto.randomBytes(16).toString("hex");
    const env = verifyWhopWebhook({
      rawBody: body,
      headers: { "webhook-id": "msg_1", "webhook-timestamp": ts, "webhook-signature": `v1,${other} v1,${sig}` },
      secret,
    });
    eq(env.id, "msg_1");
  });

  check("des en-têtes manquants sont rejetés", () => {
    let threw = false;
    try {
      verifyWhopWebhook({ rawBody: body, headers: {}, secret });
    } catch {
      threw = true;
    }
    assert(threw, "sans en-tête, pas de vérification possible");
  });

  console.log("\n── Étage 3 · détection des moments ──");

  const tr = await new MockTranscriptionProvider().transcribe("mock", { durationSec: 240 });

  check("la détection respecte les bornes de durée", () => {
    const moments = detectMoments(tr.segments, { minSeconds: 18, maxSeconds: 60, limit: 8 });
    assert(moments.length > 0, "aucun moment détecté");
    for (const m of moments) {
      assert(m.durationSec >= 18 - 0.01, `moment trop court : ${m.durationSec}`);
      assert(m.durationSec <= 60 + 0.01, `moment trop long : ${m.durationSec}`);
    }
  });

  check("deux moments retenus ne se recouvrent pas au-delà du seuil", () => {
    const moments = detectMoments(tr.segments, { minSeconds: 15, maxSeconds: 75, limit: 8, overlapThreshold: 0.35 });
    for (let i = 0; i < moments.length; i += 1) {
      for (let j = i + 1; j < moments.length; j += 1) {
        const a = moments[i];
        const b = moments[j];
        const inter = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
        const ratio = inter / Math.min(a.durationSec, b.durationSec);
        assert(ratio <= 0.35 + 0.001, `recouvrement de ${(ratio * 100).toFixed(0)} % entre deux moments`);
      }
    }
  });

  check("la détection est déterministe", () => {
    const a = detectMoments(tr.segments, { limit: 6 });
    const b = detectMoments(tr.segments, { limit: 6 });
    eq(a.map((m) => [m.startSec, m.score]), b.map((m) => [m.startSec, m.score]));
  });

  check("un passage purement logistique est pénalisé", () => {
    const housekeeping = [
      { idx: 0, startSec: 0, endSec: 8, text: "Bienvenue dans l'épisode, merci à tous ceux qui ont partagé le dernier épisode." },
      { idx: 1, startSec: 8, endSec: 16, text: "Pensez à vous abonner, le lien est en description, à bientôt pour le prochain épisode." },
      { idx: 2, startSec: 16, endSec: 24, text: "On fait une pause et on revient juste après cette page de notre partenaire." },
    ];
    const strong = [
      { idx: 0, startSec: 0, endSec: 8, text: "Ce que personne ne te dit, c'est que 90 % des gens abandonnent avant six mois." },
      { idx: 1, startSec: 8, endSec: 16, text: "J'ai mis sept ans à comprendre que je travaillais sur le mauvais problème." },
      { idx: 2, startSec: 16, endSec: 24, text: "Et le jour où j'ai arrêté, j'ai fait plus de chiffre en trois mois qu'en quatre ans." },
    ];
    const h = detectMoments(housekeeping, { minSeconds: 15, maxSeconds: 40, minScore: 0 })[0];
    const s = detectMoments(strong, { minSeconds: 15, maxSeconds: 40, minScore: 0 })[0];
    assert(h && s, "les deux passages doivent produire un moment");
    assert(s.score > h.score + 15, `le passage fort (${s.score}) doit dominer la logistique (${h.score})`);
  });

  check("chaque score est expliqué critère par critère", () => {
    const m = detectMoments(tr.segments, { limit: 1 })[0];
    assert(m.criteria.length === 8, `8 critères attendus, ${m.criteria.length} trouvés`);
    const total = m.criteria.reduce((s, c) => s + c.points, 0) + m.penalties.reduce((s, c) => s + c.points, 0);
    eq(Math.max(0, Math.min(100, Math.round(total))), m.score, "le score doit être la somme des critères");
  });

  console.log("\n── Étage 3 · hooks ──");

  check("un hook court et chiffré bat un hook long et vague", () => {
    const context = "En 2025, 68 % des créateurs qui publiaient trois fois par semaine ont doublé leur audience.";
    const good = scoreHook("68 % ont doublé leur audience", context).total;
    const bad = scoreHook(
      "Dans cette vidéo nous allons parler ensemble de différentes choses intéressantes au sujet de la publication",
      context,
    ).total;
    assert(good > bad, `${good} devrait dépasser ${bad}`);
  });

  check("un hook sans rapport avec le passage perd en fidélité", () => {
    const context = "La motivation c'est une émotion, tu ne construis pas une entreprise sur une émotion.";
    const faithful = scoreHook("La motivation est une émotion", context);
    const invented = scoreHook("La recette secrète des millionnaires", context);
    const f = faithful.components.find((c) => c.key === "fidelity")!.points;
    const i = invented.components.find((c) => c.key === "fidelity")!.points;
    assert(f > i, `fidélité ${f} devrait dépasser ${i}`);
  });

  check("les hooks générés respectent la longueur d'écran", () => {
    const moment = detectMoments(tr.segments, { limit: 1 })[0];
    const hooks = generateHeuristicHooks(moment);
    assert(hooks.length >= 4, `trop peu de hooks : ${hooks.length}`);
    for (const h of hooks) assert(h.text.length <= 90, `hook trop long : ${h.text}`);
    const sorted = [...hooks].sort((a, b) => b.score - a.score);
    eq(hooks[0].text, sorted[0].text, "les hooks doivent sortir triés par score");
  });

  check("seuls les vrais nombres servent d'accroche chiffrée", () => {
    eq(extractNumericFigures("j'ai mis sept ans"), []);
    assert(extractNumericFigures("68 % des créateurs").length > 0, "68 % doit être retenu");
  });

  check("les mots vides accentués sont bien filtrés (comparaison sans accents)", () => {
    // Régression : la liste est écrite accentuée mais comparée sans accents.
    // Sans normalisation du Set, « même » remontait comme sujet de hook.
    const topics = extractTopics("C'est la même erreur que tout le monde répète déjà.");
    assert(!topics.includes("même") && !topics.includes("meme"), `mot vide retenu : ${topics.join(", ")}`);
  });

  check("un numéral écrit en lettres n'est pas un sujet de hook", () => {
    const topics = extractTopics("C'est les deux ans où j'ai eu peur de demander de l'aide.");
    assert(!topics.includes("deux"), `numéral retenu : ${topics.join(", ")}`);
    assert(topics.includes("aide"), "le vrai sujet doit ressortir");
  });

  check("l'extraction du sujet évite les formes verbales", () => {
    const topics = extractTopics("Tu ne construis pas une entreprise sur une émotion, mais sur des contraintes.");
    assert(topics.length > 0, "aucun sujet extrait");
    assert(!topics.includes("construis"), `forme verbale retenue : ${topics.join(", ")}`);
  });

  console.log("\n── Étage 4 · montage ──");

  check("le contrôle qualité repère un format non vertical", () => {
    const r = qaCheck({ durationSec: 30, hook: "Un hook correct ici", width: 1920, height: 1080, minSeconds: 15, maxSeconds: 60 });
    assert(r.issues.some((i) => i.includes("9:16")), "le format paysage doit être signalé");
    assert(r.score < 100, "le score doit baisser");
  });

  check("le contrôle qualité repère l'absence de hook et la durée hors bornes", () => {
    const r = qaCheck({ durationSec: 8, hook: null, width: 1080, height: 1920, minSeconds: 15, maxSeconds: 60 });
    assert(r.issues.length >= 2, `deux problèmes attendus, ${r.issues.length} trouvés`);
  });

  check("un clip conforme obtient 100", () => {
    const r = qaCheck({ durationSec: 32, hook: "Ce que personne ne te dit", width: 1080, height: 1920, minSeconds: 15, maxSeconds: 60 });
    eq(r.score, 100);
    eq(r.issues, []);
  });

  check("les sous-titres sont découpés en groupes lisibles", () => {
    const words = Array.from({ length: 9 }, (_, i) => ({ text: `mot${i}`, start: i, end: i + 1 }));
    const chunks = chunkWords(words, 4);
    eq(chunks.length, 3);
    eq(chunks[0].text, "mot0 mot1 mot2 mot3");
    eq(chunks[0].start, 0);
    eq(chunks[2].end, 9);
  });

  check("le fichier ASS rebase les temps sur le début du clip", () => {
    const ass = buildAss({
      segments: [{ idx: 0, startSec: 100, endSec: 104, text: "Phrase du clip", words: [] }],
      clipStartSec: 98,
      clipEndSec: 120,
      hook: "Mon hook",
    });
    assert(ass.includes("PlayResX: 1080"), "résolution absente");
    assert(ass.includes("Style: Hook"), "style du hook absent");
    assert(ass.includes("0:00:02.00"), `temps non rebasé :\n${ass}`);
    assert(!ass.includes("0:01:40"), "le temps absolu ne doit pas apparaître");
  });

  check("le texte ASS est échappé", () => {
    const ass = buildAss({
      segments: [{ idx: 0, startSec: 0, endSec: 2, text: "accolade { et retour\nligne" }],
      clipStartSec: 0,
      clipEndSec: 10,
    });
    assert(!ass.includes("{ et"), "une accolade non échappée casserait le rendu libass");
    assert(ass.includes("\\N"), "le retour à la ligne doit devenir \\N");
  });

  console.log("\n── Étage 5 · Metricool ──");

  check("la charge utile respecte le format attendu par l'API", () => {
    const payload = buildSchedulePayload({
      dateTimeLocal: "2026-08-01T10:00:00",
      timezone: "Europe/Paris",
      text: "Mon clip",
      networks: ["instagram", "tiktok"],
      mediaUrl: "https://exemple.com/clip.mp4",
      firstCommentText: "Premier commentaire",
    });
    eq(payload.publicationDate, { dateTime: "2026-08-01T10:00:00", timezone: "Europe/Paris" });
    eq(payload.providers, [{ network: "instagram" }, { network: "tiktok" }]);
    eq(payload.text, "Mon clip");
    eq(payload.autoPublish, true);
    eq(payload.draft, false);
    eq(payload.saveExternalMediaFiles, true);
    eq(payload.firstCommentText, "Premier commentaire");
    eq(payload.media, ["https://exemple.com/clip.mp4"]);
  });

  check("le format de média alternatif (mediaId) est pris en charge", () => {
    const payload = buildSchedulePayload({
      dateTimeLocal: "2026-08-01T10:00:00",
      text: "x",
      networks: ["facebook"],
      mediaUrl: "https://exemple.com/clip.mp4",
      mediaMode: "mediaId",
    });
    eq(payload.media, { mediaId: "https://exemple.com/clip.mp4" });
  });

  check("la date locale ne porte aucun décalage horaire", () => {
    const d = new Date("2026-08-01T08:00:00Z");
    const local = toMetricoolLocal(d, "Europe/Paris");
    eq(local, "2026-08-01T10:00:00");
    assert(!/[+Z]/.test(local.slice(10)), "la date ne doit pas contenir d'offset");
    eq(toMetricoolLocal(d, "UTC"), "2026-08-01T08:00:00");
  });

  check("les options réseau sont posées dans le bon bloc", () => {
    eq(networkDataFor("instagram", true), { instagramData: { type: "REEL" } });
    eq(networkDataFor("youtube", true), { youtubeData: { type: "SHORT", privacy: "public" } });
    const payload = buildSchedulePayload({
      dateTimeLocal: "2026-08-01T10:00:00",
      text: "x",
      networks: ["instagram"],
      networkData: networkDataFor("instagram", true),
    });
    eq(payload.instagramData, { type: "REEL" });
  });

  console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} test(s) réussis, ${failed} échec(s)`);
  if (failed) {
    console.log("\nÉchecs :");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
