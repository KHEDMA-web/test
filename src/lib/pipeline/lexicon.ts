/** Lexiques français utilisés par la détection de moments et le scoring de hooks. */

/** Mots à forte charge émotionnelle, par famille. */
export const EMOTION_LEXICON: Record<string, string[]> = {
  peur: ["peur", "terrifiant", "angoisse", "paniqué", "flippé", "risque", "danger", "pire", "échec", "raté", "perdu", "honte"],
  colere: ["arnaque", "mensonge", "injuste", "scandale", "ras-le-bol", "insupportable", "trahi", "furieux"],
  surprise: ["incroyable", "jamais", "personne", "choqué", "dingue", "fou", "inattendu", "retournement", "soudain", "brutalement"],
  tristesse: ["seul", "solitude", "pleuré", "douleur", "regret", "manqué", "brisé", "épuisé", "fatigué", "burn-out"],
  desir: ["liberté", "rêve", "réussir", "gagner", "doubler", "exploser", "fortune", "succès", "ambition", "transformer"],
  fierte: ["fier", "accompli", "réussi", "record", "meilleur", "champion", "première fois"],
};

/** Marqueurs de retournement : indiquent un arc narratif dans le passage. */
export const TURN_MARKERS = [
  "sauf que", "mais en fait", "le problème c'est", "ce que personne", "jusqu'au jour",
  "et là", "résultat", "sauf qu'", "en réalité", "la vérité c'est", "le truc c'est",
  "ce qu'on ne te dit pas", "contre-intuitif", "à l'inverse", "pourtant", "alors que",
];

/** Ouvertures qui tiennent toutes seules : bon départ de clip. */
export const STRONG_OPENERS = [
  "ce que personne", "si tu", "arrête de", "la vérité", "le problème",
  "j'ai mis", "pendant", "personne ne", "tu crois que", "imagine",
  "le truc le plus", "voici pourquoi", "la raison pour laquelle", "oublie",
];

/** Mots de liaison qui rendent un début de clip incompréhensible hors contexte. */
export const WEAK_OPENERS = [
  "donc", "et", "alors", "ouais", "bref", "enfin", "hum", "voilà", "du coup",
  "ensuite", "après", "en plus", "aussi", "mais bon", "oui", "non", "d'accord",
  "exactement", "c'est ça", "hum hum",
];

/** Remplissage oral : baisse la densité utile. */
export const FILLERS = ["euh", "heu", "hum", "bah", "ben", "genre", "quoi", "tu vois", "en fait", "voilà", "bref"];

/** Passages logistiques : sans intérêt en clip. */
export const HOUSEKEEPING = [
  "abonnez-vous", "abonner", "like", "pouce bleu", "merci à tous ceux", "bienvenue dans",
  "dans l'épisode", "on fait une pause", "à bientôt", "prochain épisode", "notification",
  "lien en description", "sponsor", "partenaire de cet épisode", "on va structurer",
];

/** Mots vides, exclus de l'extraction de mots-clés. */
export const STOPWORDS = new Set([
  "le","la","les","un","une","des","de","du","au","aux","et","ou","mais","donc","or","ni","car",
  "que","qui","quoi","dont","où","à","dans","sur","sous","avec","sans","pour","par","en","vers",
  "je","tu","il","elle","on","nous","vous","ils","elles","me","te","se","lui","leur","y",
  "ce","cet","cette","ces","mon","ton","son","ma","ta","sa","mes","tes","ses","notre","votre","nos","vos",
  "est","sont","été","être","avoir","ai","as","a","ont","avait","avais","fait","faire","va","vais","vas",
  "pas","plus","moins","très","trop","bien","tout","tous","toute","toutes","même","aussi","alors",
  "quand","comme","si","oui","non","ça","cela","c'est","j'ai","il y a","y a","là","ici","peu",
  "beaucoup","vraiment","juste","déjà","encore","toujours","jamais","rien","chose","truc","gens",
]);

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "'");
}

/** Compte les occurrences d'une liste d'expressions dans un texte normalisé. */
export function countMatches(normalizedText: string, needles: string[]): number {
  let n = 0;
  for (const needle of needles) {
    const norm = normalize(needle);
    let from = 0;
    for (;;) {
      const at = normalizedText.indexOf(norm, from);
      if (at === -1) break;
      n += 1;
      from = at + norm.length;
    }
  }
  return n;
}

/** Famille d'émotion dominante du passage, ou null. */
export function dominantEmotion(text: string): { emotion: string | null; hits: number } {
  const norm = normalize(text);
  let best: { emotion: string | null; hits: number } = { emotion: null, hits: 0 };
  for (const [emotion, words] of Object.entries(EMOTION_LEXICON)) {
    const hits = countMatches(norm, words);
    if (hits > best.hits) best = { emotion, hits };
  }
  return best;
}

export function extractKeywords(text: string, limit = 6): string[] {
  const counts = new Map<string, number>();
  for (const raw of normalize(text).split(/[^a-z0-9'-]+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([w]) => w);
}

/** Nombres, pourcentages et durées — marqueurs de spécificité. */
export function extractFigures(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\d+(?:[.,]\d+)?\s?%/g,
    /\d+(?:[.,]\d+)?\s?(?:€|euros?|dollars?|\$)/gi,
    /\d+\s?(?:ans?|mois|semaines?|jours?|heures?|minutes?)/gi,
    /\b\d{2,}\b/g,
    /\b(?:deux|trois|quatre|cinq|six|sept|huit|neuf|dix|vingt|trente|cent|mille)\b/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) out.add(m[0].trim());
  }
  return [...out];
}

/**
 * Extraction de groupes nominaux : un mot précédé d'un déterminant est
 * presque toujours un nom en français. Sans étiqueteur morphosyntaxique,
 * c'est l'heuristique qui donne les meilleurs sujets de hook — bien
 * meilleure qu'un simple comptage de mots, qui remonte des verbes
 * conjugués (« construis », « passerais »).
 */
export function extractTopics(text: string, limit = 5): string[] {
  // On travaille sur le texte d'origine pour conserver les accents dans le
  // hook affiché, mais on compte sur la forme normalisée pour regrouper
  // « L'émotion » et « une émotion ».
  const counts = new Map<string, { surface: string; weight: number }>();
  const determiners =
    "(?:les|le|la|un|une|des|du|mon|ma|mes|ton|ta|tes|son|sa|ses|cette|cet|ces|ce|votre|notre|leurs|leur|l'|d')";
  const word = "[a-zà-öø-ÿ]{4,}";
  const re = new RegExp(`\\b${determiners}\\s*(${word})(?:\\s+(${word}))?`, "giu");

  const bump = (surface: string, weight: number) => {
    const key = normalize(surface);
    if (!key || STOPWORDS.has(key) || VERB_LIKE.test(key)) return;
    const prev = counts.get(key);
    counts.set(key, { surface: prev?.surface ?? surface.toLowerCase(), weight: (prev?.weight ?? 0) + weight });
  };

  for (const m of text.matchAll(re)) {
    if (m[1]) bump(m[1], 2);
    // Un complément (« système de contraintes ») pèse moins que la tête du groupe.
    if (m[2]) bump(m[2], 1);
  }

  return [...counts.values()]
    .sort((a, b) => b.weight - a.weight || b.surface.length - a.surface.length)
    .slice(0, limit)
    .map((e) => e.surface);
}

/** Terminaisons de formes verbales conjuguées : écartées des sujets de hook. */
const VERB_LIKE = /(?:ais|ait|aient|erai|erais|erait|eront|ons|ez|ent|é|és|ée|ées|ir|er|oir|is|it|us|ut)$/;

/** Chiffres utilisables comme accroche : il faut un vrai nombre, pas « deux ». */
export function extractNumericFigures(text: string): string[] {
  return extractFigures(text).filter((f) => /\d/.test(f));
}
