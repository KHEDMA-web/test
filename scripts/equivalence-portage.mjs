/**
 * Preuve du portage : l'original TypeScript et la version autonome sont
 * exécutés sur les mêmes entrées, et leurs sorties comparées octet pour
 * octet. C'est cette comparaison qui garantit la fidélité, pas la façon
 * dont la conversion a été faite.
 */
// Lancé par « npx tsx scripts/_equivalence.mjs » : tsx se charge
// d'importer les modules TypeScript d'origine.

const ts = {
  moments: await import("../src/lib/pipeline/moments.ts"),
  hooks: await import("../src/lib/pipeline/hooks.ts"),
  lexicon: await import("../src/lib/pipeline/lexicon.ts"),
  ass: await import("../src/lib/render/ass.ts"),
};
const mjs = {
  moments: await import("../portage/Outils/moments.mjs"),
  accroches: await import("../portage/Outils/accroches.mjs"),
  lexique: await import("../portage/Outils/lexique.mjs"),
  sousTitres: await import("../portage/Outils/sous-titres.mjs"),
};

const { MockTranscriptionProvider } = await import("../src/lib/transcription/mock.ts");
const tr = await new MockTranscriptionProvider().transcribe("x", { durationSec: 300 });

let ok = 0;
let ko = 0;

function compare(nom, a, b) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja === jb) {
    console.log(`  ✓ ${nom}`);
    ok += 1;
  } else {
    console.log(`  ✗ ${nom}`);
    // Montre le premier endroit qui diverge, pas tout le tas.
    for (let i = 0; i < Math.max(ja.length, jb.length); i += 1) {
      if (ja[i] !== jb[i]) {
        console.log(`     divergence au caractère ${i}`);
        console.log(`     origine : …${ja.slice(Math.max(0, i - 50), i + 60)}`);
        console.log(`     portage : …${jb.slice(Math.max(0, i - 50), i + 60)}`);
        break;
      }
    }
    ko += 1;
  }
}

console.log("\n── Détection des moments ──");
for (const opts of [
  { minSeconds: 15, maxSeconds: 75, limit: 8 },
  { minSeconds: 18, maxSeconds: 60, limit: 6 },
  { minSeconds: 25, maxSeconds: 45, limit: 3, overlapThreshold: 0.2 },
]) {
  compare(
    `detectMoments ${JSON.stringify(opts)}`,
    ts.moments.detectMoments(tr.segments, opts),
    mjs.moments.detectMoments(tr.segments, opts),
  );
}

console.log("\n── Lexiques ──");
const texte = "Le truc le plus cher que j'ai payé, c'est les deux ans où j'ai eu peur de demander de l'aide. 68 % des gens font la même erreur.";
compare("extractTopics", ts.lexicon.extractTopics(texte), mjs.lexique.extractTopics(texte));
compare("extractKeywords", ts.lexicon.extractKeywords(texte), mjs.lexique.extractKeywords(texte));
compare("extractNumericFigures", ts.lexicon.extractNumericFigures(texte), mjs.lexique.extractNumericFigures(texte));
compare("dominantEmotion", ts.lexicon.dominantEmotion(texte), mjs.lexique.dominantEmotion(texte));

console.log("\n── Accroches ──");
const moments = ts.moments.detectMoments(tr.segments, { limit: 5 });
for (const [i, m] of moments.entries()) {
  compare(`accroches du moment ${i + 1}`, ts.hooks.generateHeuristicHooks(m), mjs.accroches.generateHeuristicHooks(m));
}
compare(
  "barème d'une accroche",
  ts.hooks.scoreHook("68 % ont doublé leur audience", texte),
  mjs.accroches.scoreHook("68 % ont doublé leur audience", texte),
);

console.log("\n── Sous-titres ──");
const coupes = [
  { start: 95, end: 112 },
  { start: 30, end: 44, zoom: 1.1 },
  { start: 150, end: 163 },
];
compare(
  "remappage sur montage à trois coupes",
  ts.ass.remapSegmentsForCuts(tr.segments, coupes),
  mjs.sousTitres.remapSegmentsForCuts(tr.segments, coupes),
);
compare(
  "fichier ASS complet",
  ts.ass.buildAss({ segments: tr.segments.slice(0, 12), clipStartSec: 0, clipEndSec: 40, hook: "Un hook de test" }),
  mjs.sousTitres.buildAss({ segments: tr.segments.slice(0, 12), clipStartSec: 0, clipEndSec: 40, hook: "Un hook de test" }),
);

console.log(`\n${ko === 0 ? "✓" : "✗"} ${ok} comparaison(s) identiques, ${ko} divergence(s)`);
process.exit(ko === 0 ? 0 : 1);
