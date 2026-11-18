/**
 * Tests de la logique métier : scoring, signature de webhook, charge utile
 * Metricool, contrôle qualité. Aucune dépendance base ou réseau.
 *
 *   npm test
 */
import crypto from "node:crypto";
import { qualifyClient, productionPriority, MIN_VIABLE_PRICE_PER_CLIP_CENTS } from "../src/lib/whop/qualify";
import { extractJsonBlock, parsePlanInput, validateClip } from "../src/lib/pipeline/editPlan";
import { remapSegmentsForCuts } from "../src/lib/render/ass";
import { buildSendcmd } from "../src/lib/render/faceTrack";
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
  console.log("\n── Étage 1 · qualification des clients ──");

  const goodClient = {
    mrrCents: 149_000,
    clipsPerMonth: 20,
    backCatalogHours: 120,
    sourcing: "CLIENT_PROVIDED" as const,
    audienceSize: 310_000,
    pastClipViews: 4_800_000,
    brief: "Podcast business hebdomadaire, épisodes de 90 minutes, clips qui tiennent seuls.",
    hookGuidelines: "Pas de majuscules criées, privilégier les chiffres.",
    niches: ["business", "podcast"],
    targetNetworks: ["instagram", "tiktok"],
    membershipStatus: "active",
    membershipValid: true,
    myNiches: ["business", "podcast"],
  };

  check("un bon client est pris", () => {
    const r = qualifyClient(goodClient);
    assert(r.score >= 70, `score trop bas : ${r.score}`);
    eq(r.decision, "prendre");
  });

  check("le volume à bas prix est refusé, même avec un bon dossier", () => {
    // Beaucoup de matière, grosse audience, mais 10 € le clip.
    const r = qualifyClient({
      ...goodClient,
      mrrCents: 39_000,
      clipsPerMonth: 40,
      backCatalogHours: 200,
      audienceSize: 95_000,
    });
    eq(r.decision, "refuser", `décision ${r.decision} pour ${(r.pricePerClipCents / 100).toFixed(2)} €/clip`);
    assert(
      r.pricePerClipCents < MIN_VIABLE_PRICE_PER_CLIP_CENTS,
      "le prix par clip doit être sous le seuil de viabilité",
    );
    assert(r.summary.includes("par clip"), "le motif doit nommer le prix par clip");
  });

  check("un client qui fournit ses rushes vaut mieux qu'un client à sourcer", () => {
    const provided = qualifyClient({ ...goodClient, sourcing: "CLIENT_PROVIDED" });
    const sourced = qualifyClient({ ...goodClient, sourcing: "SELF_SOURCED" });
    const p = provided.components.find((c) => c.key === "material")!.points;
    const sc = sourced.components.find((c) => c.key === "material")!.points;
    assert(p > sc, `${p} devrait dépasser ${sc} : aller chercher la matière est du travail en plus`);
  });

  check("un abonnement impayé ne donne pas de points de paiement", () => {
    const r = qualifyClient({ ...goodClient, membershipValid: false, membershipStatus: "past_due" });
    const pay = r.components.find((c) => c.key === "payment")!;
    assert(pay.points < 10, "un impayé ne doit pas valoir le maximum");
    assert(pay.note?.includes("ne pas commencer") ?? false, "le risque doit être explicite");
  });

  check("les scores restent bornés et chaque critère respecte son maximum", () => {
    const r = qualifyClient({ ...goodClient, mrrCents: 50_000_000, audienceSize: 90_000_000 });
    assert(r.score <= 100, `score hors borne : ${r.score}`);
    for (const c of r.components) assert(c.points <= c.max, `${c.key} dépasse son maximum`);
  });

  check("le retard d'échéance passe devant tout le reste", () => {
    const late = productionPriority({
      score: 50,
      clipsPerMonth: 10,
      clipsDelivered: 9,
      mrrCents: 29_000,
      nextDueAt: new Date(Date.now() - 6 * 3600_000),
      status: "ACTIVE",
    });
    const rich = productionPriority({
      score: 95,
      clipsPerMonth: 20,
      clipsDelivered: 0,
      mrrCents: 200_000,
      nextDueAt: new Date(Date.now() + 10 * 864e5),
      status: "ACTIVE",
    });
    assert(late.priority > rich.priority, `${late.priority} devrait dépasser ${rich.priority}`);
    assert(late.reason.includes("retard"), "le motif doit dire le retard");
  });

  check("un quota déjà livré retombe en bas de la file", () => {
    const done = productionPriority({
      score: 90,
      clipsPerMonth: 8,
      clipsDelivered: 8,
      mrrCents: 100_000,
      status: "ACTIVE",
    });
    assert(done.priority <= 5, `priorité ${done.priority} trop haute pour un quota terminé`);
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

  console.log("\n── Étage 4 · lecture du plan de Claude ──");

  check("le JSON est extrait d'une réponse entourée de prose", () => {
    const raw = "Voici mes deux clips, j'ai privilégié la chute.\n\n```json\n{\"clips\":[{\"cuts\":[{\"start\":1,\"end\":20}]}]}\n```\n\nDis-moi si tu veux autre chose.";
    const json = extractJsonBlock(raw);
    assert(json !== null, "aucun bloc extrait");
    const parsed = parsePlanInput(raw);
    assert(parsed.ok, `échec : ${parsed.issues.map((i) => i.message).join(", ")}`);
    eq(parsed.clips.length, 1);
  });

  check("les accolades imbriquées ne cassent pas l'extraction", () => {
    const raw = '{"clips":[{"cuts":[{"start":1,"end":20}],"captionOverrides":[{"start":0,"end":2,"text":"a}b"}]}]}';
    const parsed = parsePlanInput(raw);
    assert(parsed.ok, `échec : ${parsed.issues.map((i) => i.message).join(", ")}`);
    eq(parsed.clips[0].captionOverrides?.[0].text, "a}b");
  });

  check("un plan unique sans tableau `clips` est accepté", () => {
    const parsed = parsePlanInput('{"title":"Un clip","cuts":[{"start":5,"end":30}]}');
    assert(parsed.ok, "le plan unique doit passer");
    eq(parsed.clips[0].title, "Un clip");
  });

  check("les timecodes en mm:ss sont convertis en secondes", () => {
    const parsed = parsePlanInput('{"clips":[{"cuts":[{"start":"1:31.5","end":"2:11"}]}]}');
    assert(parsed.ok, "la conversion doit réussir");
    eq(parsed.clips[0].cuts[0].start, 91.5);
    eq(parsed.clips[0].cuts[0].end, 131);
  });

  check("une réponse sans JSON est refusée avec un message actionnable", () => {
    const parsed = parsePlanInput("Je pense qu'il faut couper vers une minute trente.");
    assert(!parsed.ok, "aucun plan ne devrait être lu");
    assert(parsed.issues[0].message.includes("Aucun bloc JSON"), parsed.issues[0].message);
  });

  check("une coupe sans `end` est signalée précisément", () => {
    const parsed = parsePlanInput('{"clips":[{"cuts":[{"start":10}]}]}');
    assert(!parsed.ok, "le plan ne doit pas passer");
    assert(
      parsed.issues.some((i) => i.message.includes("`start` et `end`")),
      parsed.issues.map((i) => i.message).join(" | "),
    );
  });

  const planCtx = {
    durationSec: 240,
    minClipSeconds: 18,
    maxClipSeconds: 60,
    segmentBoundaries: [0, 12.4, 30.1, 48.9, 61.2, 95.6, 120.0],
  };

  check("une coupe au-delà du rush est tronquée, pas rejetée", () => {
    const v = validateClip({ cuts: [{ start: 200, end: 300 }], hook: "Un hook correct" }, planCtx);
    eq(v.cuts[0].end, 240);
    assert(v.issues.some((i) => i.level === "warning" && i.message.includes("au-delà")), "le recadrage doit être signalé");
    assert(!v.issues.some((i) => i.level === "error"), "ce n'est pas une erreur bloquante");
  });

  check("une coupe inversée est une erreur", () => {
    const v = validateClip({ cuts: [{ start: 60, end: 30 }] }, planCtx);
    assert(v.issues.some((i) => i.level === "error"), "une fin avant le début doit bloquer");
  });

  check("les coupes sont recalées sur la parole", () => {
    const v = validateClip({ cuts: [{ start: 30.2, end: 61.0 }], hook: "Un hook correct" }, planCtx);
    eq(v.cuts[0].start, 30.1);
    eq(v.cuts[0].end, 61.2);
    assert(v.issues.some((i) => i.message.includes("recalée")), "le recalage doit être dit");
  });

  check("un chevauchement entre deux coupes est signalé", () => {
    const v = validateClip(
      { cuts: [{ start: 0, end: 48.9 }, { start: 30.1, end: 95.6 }], hook: "Un hook correct" },
      planCtx,
    );
    assert(v.issues.some((i) => i.message.includes("chevauchent")), "le passage vu deux fois doit alerter");
  });

  check("la durée hors bornes est un avertissement, pas un blocage", () => {
    const v = validateClip({ cuts: [{ start: 0, end: 12.4 }], hook: "Un hook correct" }, planCtx);
    assert(v.issues.some((i) => i.level === "warning" && i.message.includes("minimum")), "trop court doit alerter");
    assert(!v.issues.some((i) => i.level === "error"), "mais rester rendable");
  });

  check("un hook trop long pour l'écran est signalé", () => {
    const v = validateClip(
      { cuts: [{ start: 0, end: 48.9 }], hook: "x".repeat(80) },
      planCtx,
    );
    assert(v.issues.some((i) => i.message.includes("débordera")), "les 58 caractères doivent être rappelés");
  });

  console.log("\n── Étage 4 · rendu et sous-titres ──");

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

  check("les sous-titres suivent les coupes dans l'ordre du montage", () => {
    const segments = [
      { idx: 0, startSec: 10, endSec: 14, text: "premier", words: [{ text: "premier", start: 10, end: 14 }] },
      { idx: 1, startSec: 50, endSec: 54, text: "second", words: [{ text: "second", start: 50, end: 54 }] },
    ];
    // La deuxième coupe est prise AVANT la première dans le rush, mais
    // placée après dans le montage : l'ordre du plan doit primer.
    const out = remapSegmentsForCuts(segments, [
      { start: 48, end: 56 },
      { start: 8, end: 16 },
    ]);
    eq(out.length, 2);
    eq(out[0].text, "second");
    eq(out[0].startSec, 2);
    eq(out[1].text, "premier");
    // 8 s de première coupe, puis 10-8 = 2 s dans la seconde.
    eq(out[1].startSec, 10);
    eq(out[1].words?.[0].start, 10);
  });

  check("un segment à cheval sur une coupe est tronqué à la coupe", () => {
    const segments = [{ idx: 0, startSec: 18, endSec: 26, text: "à cheval" }];
    const out = remapSegmentsForCuts(segments, [{ start: 20, end: 24 }]);
    eq(out.length, 1);
    eq(out[0].startSec, 0);
    eq(out[0].endSec, 4);
  });

  check("un segment hors de toutes les coupes disparaît", () => {
    const segments = [{ idx: 0, startSec: 100, endSec: 108, text: "coupé au montage" }];
    eq(remapSegmentsForCuts(segments, [{ start: 0, end: 20 }]).length, 0);
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

  console.log("\n── Étage 4 · recadrage suiveur ──");

  check("les commandes de recadrage visent le filtre, pas l'étiquette seule", () => {
    // Régression : avec « fc0 » comme cible, ffmpeg ignore la commande en
    // silence et le cadre reste figé sur sa position de départ.
    const cmd = buildSendcmd("crop@fc0", [{ t: 0, x: 100 }, { t: 0.2, x: 140 }], 1.0);
    assert(cmd.includes("crop@fc0"), `cible incorrecte :\n${cmd}`);
    assert(!/^\d[\d.]*-[\d.]+ \[enter\] fc0 /m.test(cmd), "la cible ne doit pas être l'étiquette nue");
  });

  check("chaque commande porte un intervalle et le drapeau d'entrée", () => {
    // Un instant sec ne déclenche rien : il faut « début-fin [enter] ».
    const cmd = buildSendcmd("crop@fc0", [{ t: 0, x: 100 }, { t: 0.4, x: 160 }], 1.2);
    const lines = cmd.trim().split("\n");
    eq(lines.length, 2);
    assert(/^0\.000-0\.400 \[enter\] crop@fc0 x 100;$/.test(lines[0]), lines[0]);
    // La dernière commande tient jusqu'à la fin de la coupe.
    assert(/^0\.400-1\.200 \[enter\] crop@fc0 x 160;$/.test(lines[1]), lines[1]);
  });

  check("une seule position produit quand même un intervalle valide", () => {
    const cmd = buildSendcmd("crop@fc1", [{ t: 0, x: 42 }], 3).trim();
    assert(/^0\.000-3\.000 \[enter\] crop@fc1 x 42;$/.test(cmd), cmd);
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
