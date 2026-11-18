/**
 * Étage 4b — lire le plan de montage rendu par Claude.
 *
 * Le texte arrive d'une conversation : il peut être entouré de prose,
 * encadré par des ``` , contenir des timecodes en `mm:ss` alors que le
 * brief demande des secondes. Le parseur est donc tolérant sur la forme
 * et strict sur le fond : ce qui est ambigu devient un avertissement
 * visible, ce qui est inexécutable devient une erreur explicite.
 */
import { z } from "zod";
import { prisma } from "../db";
import { logEvent } from "../log";
import { formatTimecode } from "../utils";
import { PLAN_SCHEMA_VERSION } from "./brief";
import type { PlanSource } from "@prisma/client";

/** Accepte 91.3, "91.3", "1:31.3" ou "01:31". */
const timeValue = z.union([z.number(), z.string()]).transform((v, ctx) => {
  if (typeof v === "number") return v;
  const s = v.trim();
  const clock = /^(\d+):(\d{1,2}(?:[.,]\d+)?)$/.exec(s);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2].replace(",", "."));
  const hms = /^(\d+):(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/.exec(s);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3].replace(",", "."));
  const n = Number(s.replace(",", "."));
  if (Number.isFinite(n)) return n;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `timecode illisible : « ${v} »` });
  return z.NEVER;
});

/** Une coupe telle que Claude la décrit : bornes dans le temps du rush. */
export type PlanCutInput = { start: number; end: number; note?: string; zoom?: number };

const cutSchema = z
  .object({
    start: timeValue.optional(),
    startSec: timeValue.optional(),
    end: timeValue.optional(),
    endSec: timeValue.optional(),
    note: z.string().max(400).optional(),
    zoom: z.number().min(1).max(1.5).optional(),
  })
  // Le type de retour est annoté pour que `note` et `zoom` restent
  // facultatifs côté appelant, plutôt que « présents mais indéfinis ».
  .transform((c, ctx): PlanCutInput => {
    const start = c.start ?? c.startSec;
    const end = c.end ?? c.endSec;
    if (start === undefined || end === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "chaque coupe doit avoir `start` et `end`" });
      return z.NEVER;
    }
    return { start, end, note: c.note, zoom: c.zoom };
  });

const overrideSchema = z
  .object({
    start: timeValue.optional(),
    startSec: timeValue.optional(),
    end: timeValue.optional(),
    endSec: timeValue.optional(),
    text: z.string().min(1).max(300),
  })
  .transform((c, ctx): { start: number; end: number; text: string } => {
    const start = c.start ?? c.startSec;
    const end = c.end ?? c.endSec;
    if (start === undefined || end === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "chaque sous-titre imposé doit avoir `start` et `end`" });
      return z.NEVER;
    }
    return { start, end, text: c.text };
  });

const clipSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  hook: z.string().max(300).optional().nullable(),
  caption: z.string().max(3000).optional().nullable(),
  hashtags: z.array(z.string()).max(30).optional(),
  cuts: z.array(cutSchema).min(1, "au moins une coupe est nécessaire"),
  framing: z.enum(["cover", "fit-blur", "fit-bars", "face"]).optional(),
  burnSubtitles: z.boolean().optional(),
  normalizeAudio: z.boolean().optional(),
  captionOverrides: z.array(overrideSchema).optional().nullable(),
  rationale: z.string().max(4000).optional().nullable(),
  musicNote: z.string().max(500).optional().nullable(),
  momentId: z.string().optional().nullable(),
});

const payloadSchema = z.object({
  version: z.string().optional(),
  note: z.string().optional().nullable(),
  clips: z.array(clipSchema),
});

export type ParsedClip = z.infer<typeof clipSchema>;

export type PlanIssue = { level: "error" | "warning"; message: string; clipIndex?: number };

export type ParseResult = {
  ok: boolean;
  clips: ParsedClip[];
  note?: string | null;
  issues: PlanIssue[];
};

/**
 * Extrait le premier objet JSON d'un texte libre.
 * Gère les blocs ```json, la prose avant/après, et les accolades imbriquées.
 */
export function extractJsonBlock(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1] : raw;

  const start = candidate.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

/** Lit le texte collé et en sort des clips exploitables. */
export function parsePlanInput(raw: string): ParseResult {
  const issues: PlanIssue[] = [];
  const json = extractJsonBlock(raw);

  if (!json) {
    return {
      ok: false,
      clips: [],
      issues: [
        {
          level: "error",
          message:
            "Aucun bloc JSON trouvé dans le texte collé. Copiez la réponse de Claude en entier, le bloc ```json compris.",
        },
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      ok: false,
      clips: [],
      issues: [{ level: "error", message: `JSON illisible : ${(err as Error).message}` }],
    };
  }

  // Tolérance : un plan unique sans tableau `clips`.
  const normalized =
    parsed && typeof parsed === "object" && !("clips" in (parsed as object))
      ? { clips: [parsed] }
      : parsed;

  const result = payloadSchema.safeParse(normalized);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const clipIndex = typeof issue.path[1] === "number" ? issue.path[1] : undefined;
      issues.push({
        level: "error",
        message: `${issue.path.join(".") || "racine"} : ${issue.message}`,
        clipIndex,
      });
    }
    return { ok: false, clips: [], issues };
  }

  if (result.data.version && result.data.version !== PLAN_SCHEMA_VERSION) {
    issues.push({
      level: "warning",
      message: `Le plan annonce la version « ${result.data.version} », attendue « ${PLAN_SCHEMA_VERSION} ». Vérifiez le format.`,
    });
  }

  return { ok: true, clips: result.data.clips, note: result.data.note, issues };
}

export type ValidationContext = {
  durationSec: number;
  minClipSeconds: number;
  maxClipSeconds: number;
  /** Bornes de segments, pour éviter de couper au milieu d'un mot. */
  segmentBoundaries?: number[];
};

export type ValidatedClip = {
  clip: ParsedClip;
  cuts: Array<{ start: number; end: number; note?: string; zoom?: number }>;
  totalDuration: number;
  issues: PlanIssue[];
};

/** Tolérance de recalage sur une borne de segment, en secondes. */
const SNAP_TOLERANCE = 0.35;

function snap(value: number, boundaries: number[] | undefined): number {
  if (!boundaries?.length) return value;
  let best = value;
  let bestDelta = SNAP_TOLERANCE;
  for (const b of boundaries) {
    const d = Math.abs(b - value);
    if (d < bestDelta) {
      bestDelta = d;
      best = b;
    }
  }
  return best;
}

/** Vérifie un clip contre le rush réel et recale ce qui peut l'être. */
export function validateClip(clip: ParsedClip, ctx: ValidationContext, index = 0): ValidatedClip {
  const issues: PlanIssue[] = [];
  const cuts: ValidatedClip["cuts"] = [];

  for (const [i, cut] of clip.cuts.entries()) {
    let { start, end } = cut;

    if (end <= start) {
      issues.push({
        level: "error",
        message: `Coupe ${i + 1} : la fin (${end}s) n'est pas après le début (${start}s).`,
        clipIndex: index,
      });
      continue;
    }
    if (start < 0) {
      issues.push({ level: "warning", message: `Coupe ${i + 1} : début négatif ramené à 0.`, clipIndex: index });
      start = 0;
    }
    if (ctx.durationSec > 0 && end > ctx.durationSec) {
      issues.push({
        level: "warning",
        message: `Coupe ${i + 1} : fin à ${end.toFixed(1)}s au-delà du rush (${ctx.durationSec.toFixed(1)}s), tronquée.`,
        clipIndex: index,
      });
      end = ctx.durationSec;
    }
    if (ctx.durationSec > 0 && start >= ctx.durationSec) {
      issues.push({
        level: "error",
        message: `Coupe ${i + 1} : commence à ${start.toFixed(1)}s, après la fin du rush.`,
        clipIndex: index,
      });
      continue;
    }

    // Recalage sur les bornes de segments : évite de couper au milieu d'un mot.
    const snappedStart = snap(start, ctx.segmentBoundaries);
    const snappedEnd = snap(end, ctx.segmentBoundaries);
    if (snappedStart !== start || snappedEnd !== end) {
      issues.push({
        level: "warning",
        message: `Coupe ${i + 1} recalée sur la parole : ${start.toFixed(2)}→${end.toFixed(2)} devient ${snappedStart.toFixed(2)}→${snappedEnd.toFixed(2)}.`,
        clipIndex: index,
      });
    }
    if (snappedEnd - snappedStart < 0.4) {
      issues.push({ level: "error", message: `Coupe ${i + 1} : trop courte après recalage.`, clipIndex: index });
      continue;
    }

    cuts.push({ start: snappedStart, end: snappedEnd, note: cut.note, zoom: cut.zoom });
  }

  const totalDuration = cuts.reduce((s, c) => s + (c.end - c.start), 0);

  if (cuts.length === 0) {
    issues.push({ level: "error", message: "Aucune coupe exploitable dans ce clip.", clipIndex: index });
  } else {
    if (totalDuration < ctx.minClipSeconds) {
      issues.push({
        level: "warning",
        message: `Durée totale ${totalDuration.toFixed(1)}s, sous le minimum demandé (${ctx.minClipSeconds}s).`,
        clipIndex: index,
      });
    }
    if (totalDuration > ctx.maxClipSeconds) {
      issues.push({
        level: "warning",
        message: `Durée totale ${totalDuration.toFixed(1)}s, au-dessus du maximum demandé (${ctx.maxClipSeconds}s).`,
        clipIndex: index,
      });
    }
  }

  // Chevauchements entre coupes : souvent une erreur de recopie de timecode.
  const ordered = [...cuts].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].start < ordered[i - 1].end - 0.05) {
      issues.push({
        level: "warning",
        message: `Deux coupes se chevauchent (${formatTimecode(ordered[i].start)}) : le passage sera vu deux fois.`,
        clipIndex: index,
      });
      break;
    }
  }

  if (clip.hook && clip.hook.length > 58) {
    issues.push({
      level: "warning",
      message: `Hook de ${clip.hook.length} caractères : il débordera à l'écran (58 maximum).`,
      clipIndex: index,
    });
  }
  if (!clip.hook) {
    issues.push({ level: "warning", message: "Pas de hook : la première seconde sera muette.", clipIndex: index });
  }

  return { clip, cuts, totalDuration, issues };
}

/** Lit, valide et enregistre les plans d'un texte collé. */
export async function createPlansFromInput(args: {
  rushId: string;
  raw: string;
  source?: PlanSource;
  author?: string;
}): Promise<{
  created: string[];
  issues: PlanIssue[];
  note?: string | null;
  ok: boolean;
}> {
  const rush = await prisma.rush.findUniqueOrThrow({
    where: { id: args.rushId },
    include: { client: true, segments: { orderBy: { idx: "asc" }, select: { startSec: true, endSec: true } } },
  });

  const parsed = parsePlanInput(args.raw);
  if (!parsed.ok) return { created: [], issues: parsed.issues, ok: false };

  const boundaries = [
    ...new Set(rush.segments.flatMap((s) => [Number(s.startSec.toFixed(2)), Number(s.endSec.toFixed(2))])),
  ].sort((a, b) => a - b);

  const ctx: ValidationContext = {
    durationSec: rush.durationSec ?? 0,
    minClipSeconds: rush.client?.minClipSeconds ?? 18,
    maxClipSeconds: rush.client?.maxClipSeconds ?? 60,
    segmentBoundaries: boundaries,
  };

  const issues: PlanIssue[] = [...parsed.issues];
  const created: string[] = [];

  for (const [index, clip] of parsed.clips.entries()) {
    const validated = validateClip(clip, ctx, index);
    issues.push(...validated.issues);

    if (validated.issues.some((i) => i.level === "error")) continue;

    const previous = await prisma.editPlan.count({ where: { rushId: rush.id } });
    const plan = await prisma.editPlan.create({
      data: {
        rushId: rush.id,
        clientId: rush.clientId,
        momentId: clip.momentId ?? null,
        title: clip.title ?? `${rush.title} — clip ${previous + 1}`,
        hook: clip.hook ?? null,
        caption: clip.caption ?? clip.hook ?? null,
        hashtags: clip.hashtags ?? [],
        cuts: validated.cuts as never,
        captionOverrides: (clip.captionOverrides ?? undefined) as never,
        framing: clip.framing ?? "cover",
        burnSubtitles: clip.burnSubtitles ?? true,
        normalizeAudio: clip.normalizeAudio ?? true,
        rationale: clip.rationale ?? null,
        musicNote: clip.musicNote ?? null,
        source: args.source ?? "CLAUDE_CHAT",
        author: args.author ?? "Claude (chat)",
        rawInput: args.raw.slice(0, 20000),
        warnings: validated.issues.filter((i) => i.level === "warning").map((i) => i.message),
        version: previous + 1,
      },
    });
    created.push(plan.id);

    await logEvent({
      stage: "plan",
      entity: `plan:${plan.id}`,
      message: `Plan « ${plan.title} » reçu — ${validated.cuts.length} coupe(s), ${validated.totalDuration.toFixed(1)}s`,
      data: { warnings: plan.warnings.length, source: plan.source },
    });
  }

  if (created.length === 0 && parsed.clips.length > 0) {
    issues.push({ level: "error", message: "Aucun clip n'a pu être enregistré : corrigez les erreurs ci-dessus." });
  }

  return { created, issues, note: parsed.note, ok: created.length > 0 };
}
