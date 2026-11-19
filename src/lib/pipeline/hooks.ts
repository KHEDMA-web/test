/**
 * Étage 3b — « les meilleurs hooks ».
 *
 * Deux générateurs interchangeables :
 *   - heuristique : gabarits remplis avec ce que le moment contient
 *     vraiment (chiffre, retournement, confession). Déterministe, gratuit,
 *     toujours disponible.
 *   - Claude : réécriture par LLM quand ANTHROPIC_API_KEY est présent.
 *
 * Dans les deux cas, chaque hook passe par le même scorer : un hook généré
 * par LLM n'est pas retenu d'office, il doit battre les autres.
 */
import { clamp } from "../utils";
import { config, live } from "../config";
import { extractFigures, extractNumericFigures, extractTopics, type Lang, normalize, toLang } from "./lexicon";
import type { DetectedMoment } from "./moments";

export type HookCandidate = {
  text: string;
  style: HookStyle;
  provider: string;
  score: number;
  scoreBreakdown: HookScoreBreakdown;
};

export type HookStyle =
  | "question"
  | "chiffre"
  | "contrarien"
  | "curiosity-gap"
  | "confession"
  | "promesse"
  | "callout";

export type HookScoreBreakdown = {
  components: Array<{ key: string; label: string; raw: number | string; points: number; max: number }>;
  total: number;
};

/** Longueur cible d'un hook à l'écran : lisible en une seconde. */
const IDEAL_MAX_CHARS = 58;

const POWER_OPENERS: Record<Lang, string[]> = {
  fr: [
    "personne", "arrête", "oublie", "voici", "si tu", "pourquoi", "comment",
    "ce que", "la vérité", "le secret", "j'ai", "tu crois", "imagine", "90 %",
  ],
  en: [
    "nobody", "no one", "stop", "forget", "here's", "if you", "why", "how",
    "what", "the truth", "the secret", "i ", "you think", "imagine", "90%",
  ],
};

const TENSION_MARKERS: Record<Lang, string[]> = {
  fr: ["personne", "ce que", "pourquoi", "jamais", "vraiment", "erreur", "sauf", "avant de", "au lieu de", "la seule"],
  en: ["nobody", "no one", "what", "why", "never", "really", "mistake", "except", "before you", "instead of", "the only"],
};

/**
 * Score d'un hook sur 100.
 * Barème : brièveté 20 · spécificité 20 · tension/curiosité 20 ·
 * force d'ouverture 15 · lisibilité 15 · fidélité au contenu 10.
 */
export function scoreHook(text: string, momentTranscript: string, lang: Lang = "fr"): HookScoreBreakdown {
  const chars = text.length;
  const norm = normalize(text);
  const words = text.split(/\s+/).filter(Boolean);
  const figures = extractFigures(text, lang);

  // Brièveté : plein pot jusqu'à 58 caractères, décroissance ensuite.
  const brevity =
    chars <= IDEAL_MAX_CHARS
      ? 20
      : clamp(Math.round(20 * (1 - (chars - IDEAL_MAX_CHARS) / 60)), 0, 20);

  const specificity = clamp(figures.length * 10 + (/[A-ZÉÈ][a-zéèê]+/.test(text) ? 4 : 0), 0, 20);

  // Tension : promesse d'information retenue, opposition, enjeu.
  const tension = clamp(TENSION_MARKERS[lang].filter((m) => norm.includes(normalize(m))).length * 7, 0, 20);

  const opener = POWER_OPENERS[lang].some((p) => norm.startsWith(normalize(p))) ? 15 : /\?$/.test(text) ? 10 : 5;

  // Lisibilité : mots courts, peu de ponctuation, pas de majuscules criées.
  const avgWordLen = words.reduce((s, w) => s + w.length, 0) / Math.max(1, words.length);
  const shouted = /[A-Z]{4,}/.test(text);
  const punctHeavy = (text.match(/[!?.]{2,}|…/g) ?? []).length > 0;
  const readability = clamp(
    15 - Math.round(Math.max(0, avgWordLen - 6) * 3) - (shouted ? 6 : 0) - (punctHeavy ? 4 : 0),
    0,
    15,
  );

  // Fidélité : le hook doit reprendre des mots du passage, sinon c'est du clickbait.
  const momentNorm = normalize(momentTranscript);
  const contentWords = words.filter((w) => w.length > 4).map((w) => normalize(w).replace(/[^a-z0-9']/g, ""));
  const overlap = contentWords.filter((w) => w && momentNorm.includes(w)).length;
  const fidelity = clamp(Math.round((overlap / Math.max(1, contentWords.length)) * 10), 0, 10);

  const components = [
    { key: "brevity", label: "Brièveté", raw: `${chars} car.`, points: brevity, max: 20 },
    { key: "specificity", label: "Spécificité", raw: figures.join(", ") || "aucun chiffre", points: specificity, max: 20 },
    { key: "tension", label: "Tension / curiosité", raw: tension / 7, points: tension, max: 20 },
    { key: "opener", label: "Force d'ouverture", raw: words[0] ?? "", points: opener, max: 15 },
    { key: "readability", label: "Lisibilité à l'écran", raw: `${avgWordLen.toFixed(1)} car./mot`, points: readability, max: 15 },
    { key: "fidelity", label: "Fidélité au contenu", raw: `${overlap}/${contentWords.length} mots repris`, points: fidelity, max: 10 },
  ];

  return { components, total: clamp(components.reduce((s, c) => s + c.points, 0), 0, 100) };
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?]+[.!?]?/);
  return (m?.[0] ?? text).trim();
}

function stripTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?\s]+$/, "");
}


/**
 * Gabarits de hooks, par langue. Un rush anglais doit donner un hook anglais :
 * sortir « Ce que personne ne te dit sur country » sur un passage en anglais,
 * c'est un clip inutilisable.
 */
type HookTemplates = {
  figureAlone: (f: string) => string;
  figureHides: (f: string) => string;
  whyNotWorking: (t: string) => string;
  curiosityGap: (t: string) => string;
  contrarianTruth: (t: string) => string;
  stopBelieving: (t: string) => string;
  emotion: Record<string, (t: string) => string>;
  emotionFallback: (t: string) => string;
  method: (a: string, b: string) => string;
  callout: (t: string) => string;
  fallbackTopic: string;
  questionSuffix: string;
};

const TEMPLATES: Record<Lang, HookTemplates> = {
  fr: {
    figureAlone: (f) => `${f} — et personne n'en parle`,
    figureHides: (f) => `Ce que ${f} cache vraiment`,
    whyNotWorking: (t) => `Pourquoi ${t} ne marche pas pour toi`,
    curiosityGap: (t) => `Ce que personne ne te dit sur ${t}`,
    contrarianTruth: (t) => `La vérité sur ${t} est l'inverse`,
    stopBelieving: (t) => `Arrête de croire ça sur ${t}`,
    emotion: {
      peur: (t) => `J'ai eu peur de le dire : ${t}`,
      tristesse: (t) => `Le prix réel de ${t}`,
      surprise: (t) => `Je ne m'attendais pas à ça avec ${t}`,
      colere: (t) => `Ce que ${t} m'a coûté`,
      desir: (t) => `Ce qui change tout avec ${t}`,
      fierte: (t) => `Ce que ${t} m'a appris`,
    },
    emotionFallback: (t) => `Mon erreur sur ${t}`,
    method: (a, b) => `${a} et ${b} : la méthode en 40 secondes`,
    callout: (t) => `Si tu bloques sur ${t}, regarde ça`,
    fallbackTopic: "ça",
    questionSuffix: " ?",
  },
  en: {
    figureAlone: (f) => `${f} — and nobody talks about it`,
    figureHides: (f) => `What ${f} actually hides`,
    whyNotWorking: (t) => `Why ${t} isn't working for you`,
    curiosityGap: (t) => `What nobody tells you about ${t}`,
    contrarianTruth: (t) => `The truth about ${t} is the opposite`,
    stopBelieving: (t) => `Stop believing this about ${t}`,
    emotion: {
      peur: (t) => `I was scared to say it: ${t}`,
      tristesse: (t) => `The real cost of ${t}`,
      surprise: (t) => `I did not see this coming with ${t}`,
      colere: (t) => `What ${t} cost me`,
      desir: (t) => `What changes everything with ${t}`,
      fierte: (t) => `What ${t} taught me`,
    },
    emotionFallback: (t) => `The mistake I made with ${t}`,
    method: (a, b) => `${a} and ${b}: the method in 40 seconds`,
    callout: (t) => `If you're stuck on ${t}, watch this`,
    fallbackTopic: "this",
    questionSuffix: "?",
  },
};

/** Hooks construits à partir de ce que le moment contient réellement. */
export function generateHeuristicHooks(moment: DetectedMoment): HookCandidate[] {
  const transcript = moment.transcript;
  const lang = toLang(moment.language);
  const T = TEMPLATES[lang];
  // Seuls les vrais nombres servent d'accroche : « deux » ne tient pas un hook.
  const figures = extractNumericFigures(transcript, lang);
  const topics = extractTopics(transcript, 5, lang);
  const lead = stripTrailingPunct(firstSentence(transcript)).slice(0, 90);
  const topic = topics[0] ?? moment.keywords[0] ?? T.fallbackTopic;
  const topic2 = topics[1] ?? moment.keywords[1] ?? topic;

  const raw: Array<{ text: string; style: HookStyle }> = [];

  // 1. Le chiffre, s'il y en a un : le hook le plus solide quand il existe.
  if (figures.length) {
    raw.push({ text: T.figureAlone(figures[0]), style: "chiffre" });
    raw.push({ text: T.figureHides(figures[0]), style: "chiffre" });
  }

  // 2. La question directe.
  const q = transcript.match(/[^.!?]*\?/);
  if (q) raw.push({ text: stripTrailingPunct(q[0].trim()).slice(0, 80) + T.questionSuffix, style: "question" });
  raw.push({ text: T.whyNotWorking(topic), style: "question" });

  // 3. Le curiosity gap.
  raw.push({ text: T.curiosityGap(topic), style: "curiosity-gap" });

  // 4. Le contrarien, si le passage contient un retournement.
  const hasTurn = (moment.criteria.find((c) => c.key === "narrative")?.points ?? 0) > 0;
  if (hasTurn) raw.push({ text: T.contrarianTruth(topic), style: "contrarien" });
  raw.push({ text: T.stopBelieving(topic), style: "contrarien" });

  // 5. La confession, si le passage est chargé émotionnellement.
  if (moment.emotion) {
    const confession = T.emotion[moment.emotion] ?? T.emotionFallback;
    raw.push({ text: confession(topic), style: "confession" });
  }

  // 6. La promesse concrète.
  raw.push({ text: T.method(topic, topic2), style: "promesse" });

  // 7. Le callout d'audience.
  raw.push({ text: T.callout(topic), style: "callout" });

  // 8. La phrase du passage elle-même : souvent la meilleure accroche.
  if (lead.length <= 70) raw.push({ text: lead, style: "curiosity-gap" });

  // Déduplication puis scoring.
  const seen = new Set<string>();
  return raw
    .filter((h) => {
      const k = normalize(h.text);
      if (seen.has(k) || h.text.length < 12) return false;
      seen.add(k);
      return true;
    })
    .map((h) => {
      const breakdown = scoreHook(h.text, transcript, lang);
      return { text: h.text, style: h.style, provider: "heuristic", score: breakdown.total, scoreBreakdown: breakdown };
    })
    .sort((a, b) => b.score - a.score);
}

const HOOK_SYSTEM_PROMPT = `Tu écris des hooks pour des clips verticaux courts (TikTok, Reels, Shorts) en français.

Un hook est le texte affiché sur la première seconde du clip. Contraintes :
- 58 caractères maximum, idéalement moins de 45
- il porte sur ce que dit RÉELLEMENT le passage, jamais une promesse absente du contenu
- pas de majuscules criées, pas d'emoji, pas de ponctuation multiple
- il crée une tension (information retenue, opposition, enjeu concret)
- il réutilise les mots forts du passage, surtout les chiffres

Tu proposes plusieurs angles différents, pas plusieurs variantes du même angle.
Appelle l'outil emit_hooks pour rendre ta réponse.`;

type LlmHook = { text: string; style: string };

/** Réécriture des hooks par Claude, quand la clé est configurée. */
async function generateLlmHooks(moment: DetectedMoment, guidelines?: string | null): Promise<HookCandidate[]> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.hooks.anthropicKey });

  const response = await client.messages.create({
    model: config.hooks.anthropicModel,
    max_tokens: 2048,
    system: HOOK_SYSTEM_PROMPT,
    // L'effort bas suffit pour une tâche de réécriture courte et cadrée.
    output_config: { effort: "low" },
    // `tool_choice` forcé renvoie un 400 sur les modèles courants :
    // on laisse `auto` et on nomme l'outil dans la consigne.
    tools: [
      {
        name: "emit_hooks",
        description: "Rend la liste des hooks proposés pour ce passage.",
        strict: true,
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            hooks: {
              type: "array",
              description: "6 à 8 hooks, angles variés.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  text: { type: "string", description: "Le hook, 58 caractères maximum." },
                  style: {
                    type: "string",
                    enum: ["question", "chiffre", "contrarien", "curiosity-gap", "confession", "promesse", "callout"],
                  },
                },
                required: ["text", "style"],
              },
            },
          },
          required: ["hooks"],
        },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          guidelines ? `Consignes de la campagne :\n${guidelines}\n` : "",
          `Passage transcrit (${moment.durationSec.toFixed(0)} s) :\n"""\n${moment.transcript}\n"""`,
          moment.figures.length ? `\nChiffres présents : ${moment.figures.join(", ")}` : "",
          moment.emotion ? `\nTonalité dominante : ${moment.emotion}` : "",
          "\nAppelle emit_hooks avec 6 à 8 propositions.",
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Génération de hooks refusée par le modèle.");
  }

  const block = response.content.find((b) => b.type === "tool_use" && b.name === "emit_hooks");
  if (!block || block.type !== "tool_use") {
    throw new Error("Le modèle n'a pas appelé emit_hooks.");
  }

  const input = block.input as { hooks?: LlmHook[] };
  const hooks = Array.isArray(input.hooks) ? input.hooks : [];

  return hooks
    .filter((h) => typeof h?.text === "string" && h.text.trim().length >= 8)
    .map((h) => {
      const text = h.text.trim();
      const breakdown = scoreHook(text, moment.transcript);
      return {
        text,
        style: (h.style as HookStyle) ?? "curiosity-gap",
        provider: config.hooks.anthropicModel,
        score: breakdown.total,
        scoreBreakdown: breakdown,
      };
    });
}

/**
 * Génère les hooks d'un moment.
 * Le LLM enrichit la liste heuristique, il ne la remplace pas : si l'appel
 * échoue, le pipeline continue avec les hooks déterministes.
 */
export async function generateHooks(
  moment: DetectedMoment,
  opts: { guidelines?: string | null; limit?: number } = {},
): Promise<{ hooks: HookCandidate[]; provider: string; warning?: string }> {
  const heuristic = generateHeuristicHooks(moment);
  const limit = opts.limit ?? 6;

  if (!live.hooksLlm()) {
    return { hooks: heuristic.slice(0, limit), provider: "heuristic" };
  }

  try {
    const llm = await generateLlmHooks(moment, opts.guidelines);
    const merged = [...llm, ...heuristic];
    const seen = new Set<string>();
    const deduped = merged.filter((h) => {
      const k = normalize(h.text);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return {
      hooks: deduped.sort((a, b) => b.score - a.score).slice(0, limit),
      provider: config.hooks.anthropicModel,
    };
  } catch (err) {
    return {
      hooks: heuristic.slice(0, limit),
      provider: "heuristic",
      warning: `Hooks LLM indisponibles (${(err as Error).message}) — repli heuristique.`,
    };
  }
}
