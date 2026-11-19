/**
 * Lexiques utilisés par la détection de moments et le scoring de hooks.
 *
 * Deux langues sont couvertes : le français et l'anglais. Ça n'est pas un
 * confort — mesuré sur un rush anglais passé dans les tables françaises, les
 * critères émotion, chiffres et retournement tombaient tous à zéro et tous les
 * candidats sortaient au même score : la détection ne discriminait plus rien,
 * et les sujets de hook étaient des mots vides anglais (« what », « your »).
 *
 * Chaque fonction prend la langue en dernier argument et reste en français par
 * défaut. La langue vient de la transcription, qui la renvoie déjà.
 */

export type Lang = "fr" | "en";

/** Ramène un code renvoyé par Whisper (« en », « en-US », « eng ») à une langue connue. */
export function toLang(code: string | null | undefined): Lang {
  const c = (code ?? "").toLowerCase();
  return c.startsWith("en") ? "en" : "fr";
}

/** Mots à forte charge émotionnelle, par famille. */
export const EMOTION_LEXICON: Record<string, string[]> = {
  peur: ["peur", "terrifiant", "angoisse", "paniqué", "flippé", "risque", "danger", "pire", "échec", "raté", "perdu", "honte"],
  colere: ["arnaque", "mensonge", "injuste", "scandale", "ras-le-bol", "insupportable", "trahi", "furieux"],
  surprise: ["incroyable", "jamais", "personne", "choqué", "dingue", "fou", "inattendu", "retournement", "soudain", "brutalement"],
  tristesse: ["seul", "solitude", "pleuré", "douleur", "regret", "manqué", "brisé", "épuisé", "fatigué", "burn-out"],
  desir: ["liberté", "rêve", "réussir", "gagner", "doubler", "exploser", "fortune", "succès", "ambition", "transformer"],
  fierte: ["fier", "accompli", "réussi", "record", "meilleur", "champion", "première fois"],
};

const EMOTION_LEXICON_EN: Record<string, string[]> = {
  peur: ["afraid", "scared", "terrifying", "terrified", "panic", "anxiety", "risk", "danger", "worst", "failure", "failed", "lost", "ashamed", "shame"],
  colere: ["scam", "lie", "lied", "unfair", "outrageous", "scandal", "fed up", "betrayed", "furious", "angry", "ridiculous"],
  surprise: ["incredible", "unbelievable", "never", "nobody", "shocked", "insane", "crazy", "unexpected", "suddenly", "turns out", "plot twist"],
  tristesse: ["alone", "lonely", "cried", "pain", "regret", "missed", "broken", "exhausted", "burned out", "burnout"],
  desir: ["freedom", "dream", "succeed", "win", "double", "explode", "fortune", "success", "ambition", "transform", "rich"],
  fierte: ["proud", "achieved", "record", "best", "champion", "first time", "nailed it"],
};

/** Marqueurs de retournement : indiquent un arc narratif dans le passage. */
export const TURN_MARKERS = [
  "sauf que", "mais en fait", "le problème c'est", "ce que personne", "jusqu'au jour",
  "et là", "résultat", "sauf qu'", "en réalité", "la vérité c'est", "le truc c'est",
  "ce qu'on ne te dit pas", "contre-intuitif", "à l'inverse", "pourtant", "alors que",
];

const TURN_MARKERS_EN = [
  "except that", "but actually", "the problem is", "what nobody", "what no one",
  "until the day", "and then", "turns out", "in reality", "the truth is",
  "the thing is", "what they don't tell you", "counterintuitive", "on the contrary",
  "and yet", "whereas", "here's the catch", "plot twist",
];

/** Ouvertures qui tiennent toutes seules : bon départ de clip. */
export const STRONG_OPENERS = [
  "ce que personne", "si tu", "arrête de", "la vérité", "le problème",
  "j'ai mis", "pendant", "personne ne", "tu crois que", "imagine",
  "le truc le plus", "voici pourquoi", "la raison pour laquelle", "oublie",
];

const STRONG_OPENERS_EN = [
  "what nobody", "what no one", "if you", "stop ", "the truth", "the problem",
  "it took me", "for ", "nobody ", "you think", "imagine", "the craziest",
  "here's why", "the reason why", "forget ", "most people", "everyone thinks",
];

/** Mots de liaison qui rendent un début de clip incompréhensible hors contexte. */
export const WEAK_OPENERS = [
  "donc", "et", "alors", "ouais", "bref", "enfin", "hum", "voilà", "du coup",
  "ensuite", "après", "en plus", "aussi", "mais bon", "oui", "non", "d'accord",
  "exactement", "c'est ça", "hum hum",
];

const WEAK_OPENERS_EN = [
  "so", "and", "then", "yeah", "anyway", "well", "um", "uh", "right",
  "next", "after", "also", "plus", "but", "yes", "no", "okay", "ok",
  "exactly", "that's it", "mhm", "i mean",
];

/** Remplissage oral : baisse la densité utile. */
export const FILLERS = ["euh", "heu", "hum", "bah", "ben", "genre", "quoi", "tu vois", "en fait", "voilà", "bref"];

const FILLERS_EN = ["uh", "um", "erm", "like", "you know", "i mean", "sort of", "kind of", "basically", "actually", "literally"];

/** Passages logistiques : sans intérêt en clip. */
export const HOUSEKEEPING = [
  "abonnez-vous", "abonner", "like", "pouce bleu", "merci à tous ceux", "bienvenue dans",
  "dans l'épisode", "on fait une pause", "à bientôt", "prochain épisode", "notification",
  "lien en description", "sponsor", "partenaire de cet épisode", "on va structurer",
];

const HOUSEKEEPING_EN = [
  "subscribe", "hit the like", "smash that", "thanks to everyone", "welcome to",
  "in this episode", "let's take a break", "see you next", "next episode",
  "notification bell", "link in the description", "link below", "sponsor",
  "sponsored by", "today's sponsor", "before we start",
];

/**
 * Mots vides, exclus de l'extraction de mots-clés et de sujets.
 * La liste est écrite accentuée pour rester lisible, mais l'ensemble est
 * construit sur la forme normalisée : les comparaisons se font sans
 * accents, et sans cela « même » ne filtrait pas « meme », qui remontait
 * alors comme sujet de hook. (`normalize` est hissée, l'appel ici est sûr.)
 */
export const STOPWORDS = new Set([
  "le","la","les","un","une","des","de","du","au","aux","et","ou","mais","donc","or","ni","car",
  "que","qui","quoi","dont","où","à","dans","sur","sous","avec","sans","pour","par","en","vers",
  "je","tu","il","elle","on","nous","vous","ils","elles","me","te","se","lui","leur","y",
  "ce","cet","cette","ces","mon","ton","son","ma","ta","sa","mes","tes","ses","notre","votre","nos","vos",
  "est","sont","été","être","avoir","ai","as","a","ont","avait","avais","fait","faire","va","vais","vas",
  "pas","plus","moins","très","trop","bien","tout","tous","toute","toutes","même","aussi","alors",
  "quand","comme","si","oui","non","ça","cela","c'est","j'ai","il y a","y a","là","ici","peu",
  "beaucoup","vraiment","juste","déjà","encore","toujours","jamais","rien","chose","truc","gens",
].map((w) => normalize(w)));

const STOPWORDS_EN = new Set([
  "the","a","an","and","or","but","so","because","if","then","than","that","this","these","those",
  "which","who","whom","whose","what","where","when","why","how",
  "i","you","he","she","it","we","they","me","him","her","us","them","my","your","his","its","our","their",
  "is","are","was","were","be","been","being","am","do","does","did","have","has","had","will","would",
  "can","could","should","shall","may","might","must","get","got","go","goes","going","went",
  "of","to","in","on","at","for","with","without","from","by","about","into","over","under","up","down",
  "out","off","again","just","very","really","too","also","more","most","less","much","many","some","any",
  "all","both","each","every","no","not","never","always","still","even","only","here","there","now",
  "thing","things","stuff","people","way","time","like","well","yeah","okay","right","actually",
].map((w) => normalize(w)));

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, "'");
}

/** Toutes les tables d'une langue, rassemblées. */
export type LexiconBundle = {
  emotions: Record<string, string[]>;
  turnMarkers: string[];
  strongOpeners: string[];
  weakOpeners: string[];
  fillers: string[];
  housekeeping: string[];
  stopwords: Set<string>;
  numerals: Set<string>;
  verbLike: RegExp;
  /** Déterminants suivis d'une espace obligatoire (« la méthode »). */
  determiners: string;
  /**
   * Déterminants élidés, collés au mot (« l'émotion »). Séparés des autres
   * parce qu'ils seuls tolèrent l'absence d'espace : avec `\s*` pour tout
   * le monde, « Latitude » donnait le sujet « titude » et « actually »
   * donnait « ctually ».
   */
  elidedDeterminers: string | null;
  wordPattern: string;
  figurePatterns: RegExp[];
};

/** Numéraux écrits en toutes lettres : mauvais sujets de hook (« les deux ans »). */
const NUMERALS = new Set([
  "zero", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
  "onze", "douze", "treize", "quinze", "vingt", "trente", "quarante", "cinquante",
  "soixante", "cent", "cents", "mille", "million", "millions", "milliard", "milliards",
  "premier", "premiere", "deuxieme", "troisieme",
]);

const NUMERALS_EN = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fifteen", "twenty", "thirty", "forty", "fifty",
  "sixty", "hundred", "thousand", "million", "millions", "billion", "billions",
  "first", "second", "third",
]);

/** Terminaisons de formes verbales conjuguées : écartées des sujets de hook. */
const VERB_LIKE = /(?:ais|ait|aient|erai|erais|erait|eront|ons|ez|ent|é|és|ée|ées|ir|er|oir|is|it|us|ut)$/;

/**
 * En anglais, le participe et le prétérit sont les seules terminaisons assez
 * fiables pour écarter un verbe sans étiqueteur. On ne touche pas à « -ing » :
 * trop de noms courants finiraient dehors (« training », « meeting »).
 */
const VERB_LIKE_EN = /(?:ed|ying)$/;

const FIGURE_PATTERNS = [
  /\d+(?:[.,]\d+)?\s?%/g,
  /\d+(?:[.,]\d+)?\s?(?:€|euros?|dollars?|\$)/gi,
  /\d+\s?(?:ans?|mois|semaines?|jours?|heures?|minutes?)/gi,
  /\b\d{2,}\b/g,
  /\b(?:deux|trois|quatre|cinq|six|sept|huit|neuf|dix|vingt|trente|cent|mille)\b/gi,
];

const FIGURE_PATTERNS_EN = [
  /\d+(?:[.,]\d+)?\s?%/g,
  /\d+(?:[.,]\d+)?\s?(?:percent)/gi,
  /(?:\$|£|€)\s?\d+(?:[.,]\d+)?[kmb]?/gi,
  /\d+(?:[.,]\d+)?\s?(?:dollars?|euros?|pounds?|bucks?)/gi,
  /\d+\s?(?:years?|months?|weeks?|days?|hours?|minutes?)/gi,
  /\b\d{2,}\b/g,
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|hundred|thousand|million|billion)\b/gi,
];

const LEXICONS: Record<Lang, LexiconBundle> = {
  fr: {
    emotions: EMOTION_LEXICON,
    turnMarkers: TURN_MARKERS,
    strongOpeners: STRONG_OPENERS,
    weakOpeners: WEAK_OPENERS,
    fillers: FILLERS,
    housekeeping: HOUSEKEEPING,
    stopwords: STOPWORDS,
    numerals: NUMERALS,
    verbLike: VERB_LIKE,
    determiners:
      "(?:les|le|la|un|une|des|du|mon|ma|mes|ton|ta|tes|son|sa|ses|cette|cet|ces|ce|votre|notre|leurs|leur)",
    elidedDeterminers: "(?:l'|d')",
    wordPattern: "[a-zà-öø-ÿ]{4,}",
    figurePatterns: FIGURE_PATTERNS,
  },
  en: {
    emotions: EMOTION_LEXICON_EN,
    turnMarkers: TURN_MARKERS_EN,
    strongOpeners: STRONG_OPENERS_EN,
    weakOpeners: WEAK_OPENERS_EN,
    fillers: FILLERS_EN,
    housekeeping: HOUSEKEEPING_EN,
    stopwords: STOPWORDS_EN,
    numerals: NUMERALS_EN,
    verbLike: VERB_LIKE_EN,
    determiners: "(?:the|a|an|this|that|these|those|my|your|his|her|its|our|their|every|each)",
    elidedDeterminers: null,
    wordPattern: "[a-z][a-z'-]{3,}",
    figurePatterns: FIGURE_PATTERNS_EN,
  },
};

/** Les tables d'une langue. Inconnue ou absente, on reste en français. */
export function lexiconFor(lang: Lang = "fr"): LexiconBundle {
  return LEXICONS[lang] ?? LEXICONS.fr;
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
export function dominantEmotion(text: string, lang: Lang = "fr"): { emotion: string | null; hits: number } {
  const norm = normalize(text);
  let best: { emotion: string | null; hits: number } = { emotion: null, hits: 0 };
  for (const [emotion, words] of Object.entries(lexiconFor(lang).emotions)) {
    const hits = countMatches(norm, words);
    if (hits > best.hits) best = { emotion, hits };
  }
  return best;
}

export function extractKeywords(text: string, limit = 6, lang: Lang = "fr"): string[] {
  const stopwords = lexiconFor(lang).stopwords;
  const counts = new Map<string, number>();
  for (const raw of normalize(text).split(/[^a-z0-9'-]+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 4 || stopwords.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([w]) => w);
}

/** Nombres, pourcentages et durées — marqueurs de spécificité. */
export function extractFigures(text: string, lang: Lang = "fr"): string[] {
  const out = new Set<string>();
  for (const re of lexiconFor(lang).figurePatterns) {
    for (const m of text.matchAll(re)) out.add(m[0].trim());
  }
  return [...out];
}

/**
 * Extraction de groupes nominaux : un mot précédé d'un déterminant est
 * presque toujours un nom. Sans étiqueteur morphosyntaxique, c'est
 * l'heuristique qui donne les meilleurs sujets de hook — bien meilleure
 * qu'un simple comptage de mots, qui remonte des verbes conjugués
 * (« construis », « passerais »).
 */
export function extractTopics(text: string, limit = 5, lang: Lang = "fr"): string[] {
  // On travaille sur le texte d'origine pour conserver les accents dans le
  // hook affiché, mais on compte sur la forme normalisée pour regrouper
  // « L'émotion » et « une émotion ».
  const lex = lexiconFor(lang);
  const counts = new Map<string, { surface: string; weight: number }>();
  // Espace obligatoire après un déterminant plein, facultatif après un
  // déterminant élidé : sans cette distinction le déterminant se retrouve
  // avalé à l'intérieur du mot suivant.
  const head = lex.elidedDeterminers
    ? `(?:${lex.determiners}\\s+|${lex.elidedDeterminers}\\s*)`
    : `${lex.determiners}\\s+`;
  const re = new RegExp(`\\b${head}(${lex.wordPattern})(?:\\s+(${lex.wordPattern}))?`, "giu");

  const bump = (surface: string, weight: number) => {
    const key = normalize(surface);
    if (!key || lex.stopwords.has(key) || lex.numerals.has(key) || lex.verbLike.test(key)) return;
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

/** Chiffres utilisables comme accroche : il faut un vrai nombre, pas « deux ». */
export function extractNumericFigures(text: string, lang: Lang = "fr"): string[] {
  return extractFigures(text, lang).filter((f) => /\d/.test(f));
}
