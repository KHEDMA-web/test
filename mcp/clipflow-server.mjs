#!/usr/bin/env node
/**
 * Serveur MCP ClipFlow — branche Claude Desktop sur l'atelier local.
 *
 * Claude ne reçoit plus un brief collé à la main : il lit le travail du
 * jour, ouvre un rush, demande la transcription, pose son plan de montage,
 * déclenche le rendu, valide, et dépose le clip dans le dossier Drive.
 *
 * Le serveur ne touche pas la base : il parle au ClipFlow qui tourne en
 * local (http://localhost:3000 par défaut). Une seule source de vérité,
 * et rien à lancer de plus que `npm run dev`.
 *
 * Configuration dans claude_desktop_config.json :
 *
 *   {
 *     "mcpServers": {
 *       "clipflow": {
 *         "command": "node",
 *         "args": ["/chemin/absolu/vers/clipflow/mcp/clipflow-server.mjs"],
 *         "env": { "CLIPFLOW_URL": "http://localhost:3000" }
 *       }
 *     }
 *   }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.CLIPFLOW_URL ?? "http://localhost:3000").replace(/\/$/, "");
const TOKEN = process.env.CLIPFLOW_API_TOKEN ?? "";

/** Appel HTTP vers le ClipFlow local, avec des erreurs lisibles par Claude. */
async function call(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(
      `ClipFlow est injoignable sur ${BASE} (${err.message}). ` +
        `Lancez-le avec \`npm run dev\` dans le dossier du projet, ou corrigez CLIPFLOW_URL.`,
    );
  }

  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const payload = isJson && text ? JSON.parse(text) : text;

  if (!res.ok) {
    const detail = typeof payload === "string" ? payload : (payload.error ?? JSON.stringify(payload));
    const hint = typeof payload === "object" && payload?.hint ? ` — ${payload.hint}` : "";
    throw new Error(`${method} ${path} → ${res.status} : ${detail}${hint}`);
  }
  return payload;
}

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const server = new McpServer(
  { name: "clipflow", version: "1.0.0" },
  {
    instructions:
      "ClipFlow est l'atelier de clipping qui tourne en local. Flux de travail : " +
      "`whats_next` pour savoir par quoi commencer. Pour ajouter de la matière, `probe_source` puis " +
      "`ingest_link` acceptent un lien YouTube, une rediffusion ou un direct Twitch. Ensuite " +
      "`get_rush` et `get_transcript` pour lire la matière, " +
      "puis `submit_edit_plan` pour poser le montage (plusieurs coupes par clip sont encouragées : " +
      "retirer une digression, recoller deux passages distants). Le rendu FFmpeg est automatique. " +
      "Ensuite `review_clip` pour valider, ce qui dépose le clip dans le dossier synchronisé. " +
      "Les timecodes sont en secondes depuis le début du rush, pris dans la transcription.",
  },
);

// ── Lecture ─────────────────────────────────────────────────

server.registerTool(
  "whats_next",
  {
    title: "Le travail du jour",
    description:
      "Par quoi commencer : rushes à monter classés par urgence client, plans en attente de rendu, " +
      "clips à valider, clips non livrés, état du dossier de livraison. À appeler en premier.",
    inputSchema: {},
  },
  async () => text(await call("/api/work")),
);

server.registerTool(
  "get_rush",
  {
    title: "Ouvrir un rush",
    description:
      "Fiche complète d'un rush : durée et format, brief du client, moments repérés avec leur score " +
      "et leur transcription, hooks candidats, plans de montage déjà posés.",
    inputSchema: { rushId: z.string().describe("Identifiant du rush, donné par whats_next") },
  },
  async ({ rushId }) => text(await call(`/api/rushes/${encodeURIComponent(rushId)}`)),
);

server.registerTool(
  "get_transcript",
  {
    title: "Lire la transcription",
    description:
      "Transcription horodatée, segment par segment. Sur un rush long, lire par tranches avec " +
      "`from` et `to` plutôt que tout d'un coup.",
    inputSchema: {
      rushId: z.string(),
      from: z.number().optional().describe("Début de la fenêtre, en secondes"),
      to: z.number().optional().describe("Fin de la fenêtre, en secondes"),
      words: z.boolean().optional().describe("Inclure les mots horodatés (verbeux)"),
    },
  },
  async ({ rushId, from, to, words }) => {
    const q = new URLSearchParams();
    if (from !== undefined) q.set("from", String(from));
    if (to !== undefined) q.set("to", String(to));
    if (words) q.set("words", "1");
    return text(await call(`/api/rushes/${encodeURIComponent(rushId)}/transcript?${q}`));
  },
);

server.registerTool(
  "get_brief",
  {
    title: "Le brief de montage",
    description:
      "Document complet en Markdown : contexte client, transcription, moments scorés, hooks candidats " +
      "et format de réponse attendu. L'étendue de la transcription s'ajuste seule à la longueur du " +
      "rush : complète si elle tient, resserrée autour des moments repérés sinon. Dans ce cas, lis " +
      "les passages manquants avec get_transcript plutôt que de demander l'épisode entier.",
    inputSchema: {
      rushId: z.string(),
      clips: z.number().int().min(1).max(12).optional().describe("Nombre de clips demandés"),
      transcript: z
        .enum(["full", "around-moments", "none"])
        .optional()
        .describe("Étendue de la transcription incluse ; `around-moments` pour un rush long"),
    },
  },
  async ({ rushId, clips, transcript }) => {
    const q = new URLSearchParams();
    if (clips) q.set("clips", String(clips));
    if (transcript) q.set("transcript", transcript);
    return text(await call(`/api/rushes/${encodeURIComponent(rushId)}/brief?${q}`));
  },
);

server.registerTool(
  "probe_source",
  {
    title: "Inspecter un lien",
    description:
      "Dit ce qu'il y a derrière un lien sans rien télécharger : titre, durée, chaîne, format, et " +
      "s'il s'agit d'un direct en cours. À appeler avant d'importer, pour décider s'il faut prendre " +
      "toute la source ou seulement une tranche.",
    inputSchema: { url: z.string().describe("Lien YouTube, Twitch, Vimeo, ou fichier direct") },
  },
  async ({ url }) => text(await call("/api/sources/probe", { method: "POST", body: { url } })),
);

server.registerTool(
  "ingest_link",
  {
    title: "Importer un lien comme rush",
    description:
      "Récupère la source et en fait un rush. Sur une vidéo publiée, `startSec` et `endSec` évitent " +
      "de rapatrier des heures pour n'en garder que quelques minutes. Sur un direct en cours, le " +
      "passé n'est pas récupérable : `recordSeconds` capture une fenêtre à partir de maintenant. " +
      "Avec `prepare`, la transcription et la détection des moments enchaînent.",
    inputSchema: {
      url: z.string(),
      clientId: z.string().optional().describe("Client auquel rattacher ce rush"),
      title: z.string().optional(),
      startSec: z.number().min(0).optional(),
      endSec: z.number().min(0).optional(),
      recordSeconds: z.number().int().min(30).max(14_400).optional().describe("Durée de capture d'un direct"),
      maxHeight: z.number().int().min(360).max(2160).optional().describe("1080 par défaut"),
      clipsTarget: z.number().int().min(1).max(20).optional(),
      prepare: z.boolean().optional().describe("Enchaîner transcription et détection (vrai conseillé)"),
    },
  },
  async (args) => text(await call("/api/sources/ingest", { method: "POST", body: args })),
);

// ── Montage ─────────────────────────────────────────────────

const cutSchema = z.object({
  start: z.number().describe("Début de la coupe, en secondes depuis le début du rush"),
  end: z.number().describe("Fin de la coupe, en secondes"),
  note: z.string().optional().describe("Pourquoi cette coupe"),
  zoom: z.number().min(1).max(1.5).optional().describe("Resserrement facultatif sur cette coupe"),
});

const clipSchema = z.object({
  title: z.string().optional().describe("Titre interne, pour s'y retrouver"),
  hook: z.string().optional().describe("Texte affiché sur la première seconde, 58 caractères maximum"),
  caption: z.string().optional().describe("Légende du post"),
  hashtags: z.array(z.string()).optional(),
  cuts: z.array(cutSchema).min(1).describe("Les coupes, dans l'ordre du montage"),
  framing: z
    .enum(["face", "cover", "fit-blur", "fit-bars"])
    .optional()
    .describe(
      "face = le cadre suit les visages (à préférer sur une source 16:9 avec des gens à l'image), " +
        "cover = recadrage centré figé, fit-blur = plan large gardé sur fond flou, fit-bars = bandes",
    ),
  burnSubtitles: z.boolean().optional(),
  rationale: z.string().optional().describe("Ce qu'on garde, ce qu'on coupe, et pourquoi"),
  musicNote: z.string().optional(),
});

server.registerTool(
  "submit_edit_plan",
  {
    title: "Poser un montage",
    description:
      "Enregistre un ou plusieurs montages sur un rush et lance le rendu FFmpeg. " +
      "Les coupes sont recollées dans l'ordre donné, donc deux passages distants peuvent être " +
      "rapprochés. Les timecodes sont vérifiés contre le rush et recalés sur la parole pour ne pas " +
      "couper au milieu d'un mot ; les avertissements sont renvoyés.",
    inputSchema: {
      rushId: z.string(),
      clips: z.array(clipSchema).min(1).describe("Un objet par clip à produire"),
      render: z.boolean().optional().describe("Rendre tout de suite (vrai par défaut)"),
    },
  },
  async ({ rushId, clips, render }) =>
    text(
      await call("/api/edit-plans", {
        method: "POST",
        body: {
          rushId,
          author: "Claude (MCP)",
          render: render !== false,
          plan: { version: "clipflow-plan-1", clips },
        },
      }),
    ),
);

server.registerTool(
  "render_plan",
  {
    title: "Rendre un plan",
    description: "Relance le rendu FFmpeg d'un plan déjà enregistré (après correction, ou après un échec).",
    inputSchema: { planId: z.string() },
  },
  async ({ planId }) => text(await call(`/api/plans/${encodeURIComponent(planId)}/render`, { method: "POST" })),
);

// ── Clips, validation, livraison ────────────────────────────

server.registerTool(
  "list_clips",
  {
    title: "Lister les clips",
    description: "Clips produits, avec leur statut, leur contrôle qualité, leur livraison et leurs publications.",
    inputSchema: {
      status: z
        .enum(["RENDERING", "READY", "APPROVED", "REJECTED", "SCHEDULED", "PUBLISHED", "FAILED"])
        .optional(),
      clientId: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  },
  async (args) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v !== undefined) q.set(k, String(v));
    return text(await call(`/api/clips?${q}`));
  },
);

server.registerTool(
  "get_clip",
  {
    title: "Ouvrir un clip",
    description: "Détail d'un clip : coupes exécutées, recette de rendu, contrôle qualité, livraison, publications.",
    inputSchema: { clipId: z.string() },
  },
  async ({ clipId }) => text(await call(`/api/clips/${encodeURIComponent(clipId)}`)),
);

server.registerTool(
  "review_clip",
  {
    title: "Valider un clip",
    description:
      "Valide, refuse, ou renvoie un clip pour une autre version. Une validation incrémente le quota " +
      "du client et dépose le clip dans le dossier synchronisé si la livraison automatique est active.",
    inputSchema: {
      clipId: z.string(),
      decision: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]),
      comment: z.string().optional(),
    },
  },
  async ({ clipId, decision, comment }) =>
    text(
      await call(`/api/clips/${encodeURIComponent(clipId)}/review`, {
        method: "POST",
        body: { decision, comment },
      }),
    ),
);

server.registerTool(
  "deliver_clip",
  {
    title: "Déposer le clip dans le Drive",
    description:
      "Copie le clip, sa vignette et sa fiche de légende dans le dossier synchronisé, rangés par " +
      "client et par date. Le client de synchronisation s'occupe de la mise en ligne.",
    inputSchema: {
      clipId: z.string(),
      dir: z.string().optional().describe("Dossier de destination, si différent du dossier configuré"),
      overwrite: z.boolean().optional(),
    },
  },
  async ({ clipId, dir, overwrite }) =>
    text(
      await call(`/api/clips/${encodeURIComponent(clipId)}/deliver`, {
        method: "POST",
        body: { dir, overwrite },
      }),
    ),
);

server.registerTool(
  "delivery_status",
  {
    title: "État du dossier de livraison",
    description:
      "Le dossier synchronisé est-il monté et accessible en écriture, et quelles sont les dernières livraisons.",
    inputSchema: {},
  },
  async () => text(await call("/api/delivery")),
);

server.registerTool(
  "schedule_clip",
  {
    title: "Programmer la publication",
    description:
      "Met le clip en file Metricool, une publication par réseau. À n'utiliser que si Metricool est " +
      "configuré ; sinon la remise se fait par le dossier synchronisé.",
    inputSchema: {
      clipId: z.string(),
      networks: z.array(z.string()).min(1),
      scheduledAt: z.string().optional().describe("Date ISO 8601 ; dans 3 heures par défaut"),
      text: z.string().optional(),
      staggerMinutes: z.number().int().min(0).max(240).optional(),
    },
  },
  async ({ clipId, networks, scheduledAt, text: postText, staggerMinutes }) =>
    text(
      await call(`/api/clips/${encodeURIComponent(clipId)}/schedule`, {
        method: "POST",
        body: { networks, scheduledAt, text: postText, staggerMinutes },
      }),
    ),
);

// ── Un point d'entrée guidé ─────────────────────────────────

server.registerPrompt(
  "monter",
  {
    title: "Monter le prochain rush",
    description: "Prend le rush le plus urgent et le monte de bout en bout.",
    argsSchema: { rushId: z.string().optional().describe("Rush précis ; sinon le plus urgent") },
  },
  ({ rushId }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            (rushId
              ? `Monte le rush ${rushId}.`
              : "Appelle whats_next, prends le rush le plus urgent et monte-le.") +
            "\n\nMéthode : lis le rush et sa transcription, repère les passages qui tiennent seuls, " +
            "puis pose un montage par clip demandé avec submit_edit_plan. Coupe à l'intérieur des " +
            "passages quand une digression casse le rythme — plusieurs coupes par clip valent mieux " +
            "qu'un extrait brut. Écris un hook de moins de 58 caractères, tenu par ce qui est dit. " +
            "Montre-moi le résultat et les avertissements avant de valider quoi que ce soit.",
        },
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
