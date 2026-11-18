/**
 * Étage 4a — le brief de montage.
 *
 * Produit un document autonome, à coller dans une conversation avec Claude.
 * Il contient tout ce qu'il faut pour décider d'un montage — contexte
 * client, transcription horodatée, moments scorés, hooks candidats — et le
 * format exact de la réponse attendue.
 *
 * Le brief ne demande pas à Claude de suivre la détection automatique :
 * les moments sont donnés comme indices, pas comme consignes. Claude peut
 * couper ailleurs, recoller deux passages distants, ignorer un hook.
 */
import { prisma } from "../db";
import { formatTimecode } from "../utils";

export const PLAN_SCHEMA_VERSION = "clipflow-plan-1";

export type BriefOptions = {
  /** Nombre de clips demandés dans la réponse. */
  clipCount?: number;
  /** Transcription complète, ou seulement autour des meilleurs moments. */
  transcript?: "full" | "around-moments" | "none";
  /** Marge en secondes autour des moments en mode « around-moments ». */
  margin?: number;
};

export type Brief = {
  markdown: string;
  rushId: string;
  clientName: string | null;
  segmentCount: number;
  momentCount: number;
  approxChars: number;
};

function fmtRange(start: number, end: number): string {
  return `${formatTimecode(start)}–${formatTimecode(end)}`;
}

export async function buildEditBrief(rushId: string, opts: BriefOptions = {}): Promise<Brief> {
  const rush = await prisma.rush.findUniqueOrThrow({
    where: { id: rushId },
    include: {
      client: true,
      segments: { orderBy: { idx: "asc" } },
      moments: { orderBy: { score: "desc" }, include: { hooks: { orderBy: { score: "desc" } } } },
    },
  });

  const client = rush.client;
  const clipCount = opts.clipCount ?? rush.clipsTarget ?? 3;
  const transcriptMode = opts.transcript ?? "full";
  const margin = opts.margin ?? 12;
  const minSec = client?.minClipSeconds ?? 18;
  const maxSec = client?.maxClipSeconds ?? 60;

  const L: string[] = [];

  L.push(`# Brief de montage — ${rush.title}`);
  L.push("");
  L.push(
    "Tu es monteur de clips verticaux. À partir du rush décrit ci-dessous, propose " +
      `**${clipCount} clip${clipCount > 1 ? "s" : ""}** et rends-les au format JSON indiqué à la fin. ` +
      "Les coupes seront exécutées telles quelles par FFmpeg : les timecodes doivent être justes.",
  );
  L.push("");

  // ── Contexte client ───────────────────────────────────────
  L.push("## Le client");
  if (client) {
    L.push(`- **${client.name}**${client.handle ? ` (@${client.handle})` : ""}${client.planName ? ` — ${client.planName}` : ""}`);
    if (client.brief) L.push(`- Brief : ${client.brief}`);
    if (client.brandVoice) L.push(`- Ton : ${client.brandVoice}`);
    if (client.hookGuidelines) L.push(`- Consignes de hook : ${client.hookGuidelines}`);
    if (client.avoid) L.push(`- À éviter absolument : ${client.avoid}`);
    if (client.niches.length) L.push(`- Niches : ${client.niches.join(", ")}`);
    if (client.targetNetworks.length) L.push(`- Réseaux de destination : ${client.targetNetworks.join(", ")}`);
    L.push(`- Durée de clip attendue : **${minSec} à ${maxSec} secondes**`);
  } else {
    L.push("- Aucun client rattaché à ce rush : applique les règles générales du clipping vertical.");
    L.push(`- Durée de clip attendue : **${minSec} à ${maxSec} secondes**`);
  }
  L.push("");

  // ── Le rush ───────────────────────────────────────────────
  L.push("## Le rush");
  L.push(`- Durée totale : ${formatTimecode(rush.durationSec ?? 0)} (${Math.round(rush.durationSec ?? 0)} s)`);
  L.push(`- Format source : ${rush.width ?? "?"}×${rush.height ?? "?"}${rush.fps ? `, ${Math.round(rush.fps)} ips` : ""}${rush.hasAudio ? "" : ", **sans piste audio**"}`);
  L.push(`- Provenance : ${rush.origin === "CLIENT_UPLOAD" ? "déposé par le client" : "trouvé par moi"}${rush.sourceNote ? ` — ${rush.sourceNote}` : ""}`);
  if (rush.description) L.push(`- Note : ${rush.description}`);
  L.push("");

  // ── Moments détectés ──────────────────────────────────────
  if (rush.moments.length) {
    L.push("## Moments repérés automatiquement");
    L.push("");
    L.push(
      "Ce sont des **indices, pas des consignes**. Le score mesure la clippabilité " +
        "(ouverture, charge émotionnelle, chiffres, retournement, autonomie hors contexte, " +
        "débit, durée, rythme). Tu peux couper ailleurs, recoller deux passages distants, " +
        "ou ignorer complètement un moment bien noté s'il ne tient pas.",
    );
    L.push("");
    for (const m of rush.moments) {
      L.push(`### ${fmtRange(m.startSec, m.endSec)} — score ${m.score}/100${m.emotion ? ` · tonalité ${m.emotion}` : ""}`);
      L.push(`_${m.rationale ?? ""}_`);
      L.push("");
      L.push(`> ${m.transcript}`);
      L.push("");
      if (m.hooks.length) {
        L.push("Hooks candidats (générés automatiquement, à améliorer librement) :");
        for (const h of m.hooks.slice(0, 5)) {
          L.push(`- \`${h.score}\` [${h.style}] ${h.text}`);
        }
        L.push("");
      }
    }
  }

  // ── Transcription ─────────────────────────────────────────
  if (transcriptMode !== "none" && rush.segments.length) {
    const keep =
      transcriptMode === "full"
        ? rush.segments
        : rush.segments.filter((s) =>
            rush.moments.some((m) => s.endSec > m.startSec - margin && s.startSec < m.endSec + margin),
          );

    L.push(`## Transcription horodatée${transcriptMode === "around-moments" ? " (autour des moments repérés)" : ""}`);
    L.push("");
    L.push("Format : `[début → fin] locuteur : texte`. Les timecodes sont en secondes depuis le début du rush.");
    L.push("");
    L.push("```");
    for (const s of keep) {
      L.push(`[${s.startSec.toFixed(1)} → ${s.endSec.toFixed(1)}]${s.speaker ? ` ${s.speaker} :` : ""} ${s.text}`);
    }
    L.push("```");
    L.push("");
  }

  // ── Format de réponse ─────────────────────────────────────
  L.push("## Ce que tu dois rendre");
  L.push("");
  L.push("Un seul bloc JSON, sans rien d'autre que ce bloc (le commentaire éditorial va dans `rationale`) :");
  L.push("");
  L.push("```json");
  L.push(
    JSON.stringify(
      {
        version: PLAN_SCHEMA_VERSION,
        clips: [
          {
            title: "Titre court, interne, pour m'y retrouver",
            hook: "Le texte affiché sur la première seconde",
            caption: "La légende du post",
            hashtags: ["business", "podcast"],
            cuts: [
              { start: 91.3, end: 118.7, note: "la question et le début de la réponse" },
              { start: 134.2, end: 151.1, note: "la chute, recollée direct", zoom: 1.08 },
            ],
            framing: "cover",
            burnSubtitles: true,
            captionOverrides: [],
            rationale: "Pourquoi ce montage tient : ce qu'on garde, ce qu'on coupe, et pourquoi.",
            musicNote: "",
          },
        ],
      },
      null,
      2,
    ),
  );
  L.push("```");
  L.push("");
  L.push("### Règles");
  L.push("");
  L.push(`1. **Timecodes en secondes**, pris dans la transcription ci-dessus (ex. \`91.3\`), jamais en \`mm:ss\`.`);
  L.push(`2. **Durée totale par clip entre ${minSec} et ${maxSec} secondes**, somme des coupes.`);
  L.push("3. **Plusieurs coupes par clip sont encouragées** : retirer une digression, un « euh », une phrase qui retombe. Les coupes sont recollées dans l'ordre où tu les donnes — tu peux donc inverser deux passages si ça sert le montage.");
  L.push("4. **Ne coupe pas au milieu d'un mot.** Appuie-toi sur les bornes de segments, quitte à prendre 0,2 s de marge.");
  L.push("5. **Le hook fait 58 caractères maximum**, sans emoji ni majuscules criées, et doit être tenu par ce qui est réellement dit dans le clip.");
  L.push("6. `framing` : `cover` (recadrage centré, par défaut), `fit-blur` (plan large conservé, fond flou) si l'image porte une information en périphérie, `fit-bars` sinon.");
  L.push("7. `zoom` est facultatif, entre 1.0 et 1.5, pour resserrer sur une coupe précise.");
  L.push("8. `captionOverrides` est facultatif : les sous-titres sont générés automatiquement depuis la transcription. Ne les force que pour corriger une erreur de transcription, en **temps de sortie** (0 = début du clip monté).");
  L.push("9. Chaque clip doit **tenir seul** : quelqu'un qui n'a pas vu le rush doit comprendre sans contexte.");
  L.push("10. Si aucun passage ne mérite un clip, rends `\"clips\": []` et explique pourquoi dans un champ `note` à la racine. Mieux vaut zéro clip qu'un clip faible.");
  L.push("");
  L.push(`_Identifiant du rush : \`${rush.id}\` — à ne pas modifier si tu le reprends._`);

  const markdown = L.join("\n");

  return {
    markdown,
    rushId: rush.id,
    clientName: client?.name ?? null,
    segmentCount: rush.segments.length,
    momentCount: rush.moments.length,
    approxChars: markdown.length,
  };
}
