/**
 * Étage 4c — exécuter un plan de montage.
 *
 * Un plan est une décision éditoriale ; un clip est son exécution. Les deux
 * sont séparés pour qu'on puisse rejouer un rendu, comparer deux versions
 * d'un même montage, ou corriger un plan sans tout refaire.
 */
import { prisma } from "../db";
import { logEvent } from "../log";
import { renderMultiCut, type FramingMode } from "../render/ffmpeg";
import { publicUrlFor, storagePath, ensureStorage } from "../storage";
import type { Segment } from "../transcription/types";
import type { Clip, ClipStatus } from "@prisma/client";

export type PlanCut = { start: number; end: number; note?: string; zoom?: number };

/** Contrôle qualité automatique, avant ma relecture. */
export function qaCheck(args: {
  durationSec: number;
  hook?: string | null;
  width?: number | null;
  height?: number | null;
  minSeconds: number;
  maxSeconds: number;
  cutCount?: number;
}): { score: number; issues: string[] } {
  const issues: string[] = [];
  let score = 100;

  if (args.durationSec < args.minSeconds) {
    issues.push(`Trop court (${args.durationSec.toFixed(1)} s < ${args.minSeconds} s)`);
    score -= 25;
  }
  if (args.durationSec > args.maxSeconds) {
    issues.push(`Trop long (${args.durationSec.toFixed(1)} s > ${args.maxSeconds} s)`);
    score -= 20;
  }
  if (!args.hook || args.hook.trim().length < 8) {
    issues.push("Pas de hook lisible sur la première seconde");
    score -= 30;
  } else if (args.hook.length > 58) {
    issues.push(`Hook trop long pour l'écran (${args.hook.length} caractères)`);
    score -= 10;
  }
  if (args.width && args.height) {
    const ratio = args.width / args.height;
    if (Math.abs(ratio - 9 / 16) > 0.02) {
      issues.push(`Format ${args.width}×${args.height} au lieu du 9:16 attendu`);
      score -= 25;
    }
  }
  // Un montage d'une seule coupe sur un rush long est souvent un extrait brut.
  if (args.cutCount === 1 && args.durationSec > 45) {
    issues.push("Une seule coupe sur un clip long : vérifier qu'il n'y a pas de temps mort");
    score -= 5;
  }
  return { score: Math.max(0, score), issues };
}

function segmentsOf(
  rows: Array<{
    idx: number;
    startSec: number;
    endSec: number;
    text: string;
    speaker: string | null;
    confidence: number | null;
    words: unknown;
  }>,
): Segment[] {
  return rows.map((r) => ({
    idx: r.idx,
    startSec: r.startSec,
    endSec: r.endSec,
    text: r.text,
    speaker: r.speaker ?? undefined,
    confidence: r.confidence ?? undefined,
    words: (r.words as Segment["words"]) ?? undefined,
  }));
}

/** Exécute un plan : rend la vidéo et crée le clip correspondant. */
export async function renderPlan(planId: string): Promise<Clip> {
  const plan = await prisma.editPlan.findUniqueOrThrow({
    where: { id: planId },
    include: { rush: { include: { client: true } } },
  });

  const source = plan.rush.filePath ?? plan.rush.sourceUrl;
  if (!source) throw new Error("Rush sans fichier source : rendu impossible.");

  const cuts = plan.cuts as unknown as PlanCut[];
  if (!Array.isArray(cuts) || cuts.length === 0) throw new Error("Plan sans coupe exploitable.");

  await prisma.editPlan.update({ where: { id: plan.id }, data: { status: "RENDERING", error: null } });

  const clip = await prisma.clip.create({
    data: {
      rushId: plan.rushId,
      clientId: plan.clientId,
      momentId: plan.momentId,
      editPlanId: plan.id,
      title: plan.title,
      caption: plan.caption,
      hashtags: plan.hashtags,
      status: "RENDERING",
    },
  });

  try {
    await ensureStorage();
    const rows = await prisma.transcriptSegment.findMany({
      where: { rushId: plan.rushId },
      orderBy: { idx: "asc" },
    });

    const result = await renderMultiCut({
      source,
      outputPath: storagePath("clip", `${clip.id}.mp4`),
      cuts: cuts.map((c) => ({ start: c.start, end: c.end, zoom: c.zoom, note: c.note })),
      segments: segmentsOf(rows),
      captionOverrides: (plan.captionOverrides as unknown as Array<{ start: number; end: number; text: string }>) ?? undefined,
      hook: plan.hook,
      framing: plan.framing as FramingMode,
      burnSubtitles: plan.burnSubtitles,
      normalizeAudio: plan.normalizeAudio,
      hasAudio: plan.rush.hasAudio,
    });

    const qa = qaCheck({
      durationSec: result.durationSec,
      hook: plan.hook,
      width: result.recipe.width as number,
      height: result.recipe.height as number,
      minSeconds: plan.rush.client?.minClipSeconds ?? 18,
      maxSeconds: plan.rush.client?.maxClipSeconds ?? 60,
      cutCount: cuts.length,
    });

    const updated = await prisma.clip.update({
      where: { id: clip.id },
      data: {
        status: "READY",
        filePath: result.outputPath,
        previewPath: result.thumbnailPath,
        publicUrl: publicUrlFor(result.outputPath),
        durationSec: result.durationSec,
        width: result.recipe.width as number,
        height: result.recipe.height as number,
        sizeBytes: BigInt(result.sizeBytes),
        cutsSummary: cuts as never,
        renderRecipe: { ...result.recipe, command: result.command } as never,
        renderLog: result.log,
        qaScore: qa.score,
        qaIssues: qa.issues,
      },
    });

    await prisma.editPlan.update({ where: { id: plan.id }, data: { status: "RENDERED" } });
    if (plan.momentId) {
      await prisma.moment.update({ where: { id: plan.momentId }, data: { status: "CLIPPED" } });
    }

    await logEvent({
      stage: "render",
      entity: `clip:${clip.id}`,
      message: `Montage rendu — ${cuts.length} coupe(s), ${result.durationSec.toFixed(1)} s, QA ${qa.score}/100`,
      data: { plan: plan.id, issues: qa.issues },
    });

    return updated;
  } catch (err) {
    const message = (err as Error).message;
    await prisma.clip.update({ where: { id: clip.id }, data: { status: "FAILED", renderLog: message } });
    await prisma.editPlan.update({ where: { id: plan.id }, data: { status: "FAILED", error: message } });
    await logEvent({
      stage: "render",
      entity: `plan:${plan.id}`,
      level: "error",
      message: `Rendu échoué : ${message}`,
    });
    throw err;
  }
}

/**
 * Plan de secours : une coupe unique sur un moment détecté, avec son
 * meilleur hook. Utile pour dégrossir, ou quand je n'ai pas Claude sous
 * la main. Le vrai montage reste celui que je fais avec lui.
 */
export async function autoPlanFromMoment(momentId: string, hookId?: string): Promise<string> {
  const moment = await prisma.moment.findUniqueOrThrow({
    where: { id: momentId },
    include: { rush: true, hooks: { orderBy: { score: "desc" } } },
  });

  const hook = hookId ? moment.hooks.find((h) => h.id === hookId) : (moment.hooks.find((h) => h.selected) ?? moment.hooks[0]);
  const previous = await prisma.editPlan.count({ where: { rushId: moment.rushId } });

  const plan = await prisma.editPlan.create({
    data: {
      rushId: moment.rushId,
      clientId: moment.rush.clientId,
      momentId: moment.id,
      title: hook?.text ?? `${moment.rush.title} — ${Math.round(moment.startSec)}s`,
      hook: hook?.text ?? null,
      caption: hook?.text ?? null,
      cuts: [{ start: moment.startSec, end: moment.endSec, note: "moment détecté automatiquement" }] as never,
      framing:
        moment.rush.width && moment.rush.height && moment.rush.width > moment.rush.height ? "fit-blur" : "cover",
      source: "AUTO",
      author: "Détection automatique",
      rationale: moment.rationale,
      version: previous + 1,
      warnings: ["Plan automatique : une seule coupe, aucun travail éditorial."],
    },
  });

  await logEvent({
    stage: "plan",
    entity: `plan:${plan.id}`,
    message: `Plan automatique créé depuis le moment ${Math.round(moment.startSec)}s`,
  });

  return plan.id;
}

/** Ma relecture : valider, refuser, ou demander une autre version. */
export async function reviewClip(args: {
  clipId: string;
  reviewerId?: string | null;
  decision: "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";
  comment?: string;
  ratings?: Record<string, number>;
}): Promise<Clip> {
  const clip = await prisma.clip.findUniqueOrThrow({ where: { id: args.clipId } });

  await prisma.clipReview.create({
    data: {
      clipId: clip.id,
      reviewerId: args.reviewerId ?? null,
      decision: args.decision,
      comment: args.comment,
      ratings: (args.ratings ?? undefined) as never,
    },
  });

  const status: ClipStatus =
    args.decision === "APPROVED" ? "APPROVED" : args.decision === "REJECTED" ? "REJECTED" : "READY";

  const updated = await prisma.clip.update({
    where: { id: clip.id },
    data: { status, approvedAt: args.decision === "APPROVED" ? new Date() : null },
  });

  // Un clip validé compte dans le quota mensuel du client.
  if (args.decision === "APPROVED" && clip.clientId) {
    await prisma.client.update({
      where: { id: clip.clientId },
      data: { clipsDelivered: { increment: 1 } },
    });
  }

  await logEvent({
    stage: "review",
    entity: `clip:${clip.id}`,
    message:
      args.decision === "APPROVED"
        ? "Clip validé, prêt à programmer"
        : args.decision === "REJECTED"
          ? "Clip refusé"
          : "Clip renvoyé pour une autre version",
    data: { comment: args.comment },
  });

  return updated;
}
