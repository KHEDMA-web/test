/**
 * Étage 4 — montage hybride.
 *
 * Deux chemins aboutissent au même objet `Clip` :
 *   - `renderAutoDraft` : la plateforme découpe, recadre, incruste le hook
 *     et les sous-titres. Le résultat est un brouillon (`origin: AUTO`).
 *   - `submitClipperVersion` : le clipper dépose sa propre version, qui crée
 *     une nouvelle révision (`origin: CLIPPER`) liée à la précédente.
 *
 * Le brouillon auto n'est jamais écrasé : il reste consultable comme
 * référence, et la comparaison des deux versions nourrit le score du clipper.
 */
import path from "node:path";
import { prisma } from "../db";
import { logEvent } from "../log";
import { renderClip } from "../render/ffmpeg";
import { publicUrlFor, storagePath, ensureStorage } from "../storage";
import type { Segment } from "../transcription/types";
import type { Clip, ClipStatus } from "@prisma/client";
import { scoreClipper } from "../whop/recruiting";

/** Contrôle qualité automatique d'un clip, avant review humaine. */
export function qaCheck(args: {
  durationSec: number;
  hook?: string | null;
  width?: number | null;
  height?: number | null;
  minSeconds: number;
  maxSeconds: number;
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
  } else if (args.hook.length > 70) {
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
  return { score: Math.max(0, score), issues };
}

function segmentsOf(rows: Array<{ idx: number; startSec: number; endSec: number; text: string; speaker: string | null; confidence: number | null; words: unknown }>): Segment[] {
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

export type AutoDraftOptions = {
  hookId?: string;
  framing?: "cover" | "fit-blur" | "fit-bars";
  burnSubtitles?: boolean;
  assignmentId?: string;
  clipperId?: string;
};

/** Rend le brouillon automatique d'un moment. */
export async function renderAutoDraft(momentId: string, opts: AutoDraftOptions = {}): Promise<Clip> {
  const moment = await prisma.moment.findUniqueOrThrow({
    where: { id: momentId },
    include: {
      rush: { include: { campaign: true } },
      hooks: { orderBy: { score: "desc" } },
    },
  });

  const source = moment.rush.filePath ?? moment.rush.sourceUrl;
  if (!source) throw new Error("Rush sans fichier source : rendu impossible.");

  const hook = opts.hookId
    ? moment.hooks.find((h) => h.id === opts.hookId)
    : (moment.hooks.find((h) => h.selected) ?? moment.hooks[0]);

  const clip = await prisma.clip.create({
    data: {
      rushId: moment.rushId,
      campaignId: moment.rush.campaignId,
      momentId: moment.id,
      hookId: hook?.id ?? null,
      clipperId: opts.clipperId ?? null,
      assignmentId: opts.assignmentId ?? null,
      title: hook?.text ?? `${moment.rush.title} — ${Math.round(moment.startSec)}s`,
      caption: hook?.text ?? null,
      origin: "AUTO",
      status: "RENDERING",
      startSec: moment.startSec,
      endSec: moment.endSec,
    },
  });

  try {
    await ensureStorage();
    const rows = await prisma.transcriptSegment.findMany({
      where: { rushId: moment.rushId },
      orderBy: { idx: "asc" },
    });

    const outputPath = storagePath("clip", `${clip.id}.mp4`);
    const result = await renderClip({
      source,
      outputPath,
      segments: segmentsOf(rows),
      recipe: {
        startSec: moment.startSec,
        endSec: moment.endSec,
        hook: hook?.text ?? null,
        framing: opts.framing ?? (moment.rush.width && moment.rush.height && moment.rush.width > moment.rush.height ? "fit-blur" : "cover"),
        burnSubtitles: opts.burnSubtitles ?? true,
        hasAudio: moment.rush.hasAudio,
      },
    });

    const qa = qaCheck({
      durationSec: result.durationSec,
      hook: hook?.text,
      width: result.recipe.width,
      height: result.recipe.height,
      minSeconds: moment.rush.campaign?.minClipSeconds ?? 15,
      maxSeconds: moment.rush.campaign?.maxClipSeconds ?? 75,
    });

    const updated = await prisma.clip.update({
      where: { id: clip.id },
      data: {
        status: "READY",
        filePath: result.outputPath,
        previewPath: result.thumbnailPath,
        publicUrl: publicUrlFor(result.outputPath),
        durationSec: result.durationSec,
        width: result.recipe.width,
        height: result.recipe.height,
        sizeBytes: BigInt(result.sizeBytes),
        renderRecipe: { ...result.recipe, command: result.command } as never,
        renderLog: result.log,
        qaScore: qa.score,
        qaIssues: qa.issues,
      },
    });

    await prisma.moment.update({ where: { id: momentId }, data: { status: "CLIPPED" } });
    await logEvent({
      stage: "render",
      entity: `clip:${clip.id}`,
      message: `Brouillon auto rendu (${result.durationSec.toFixed(1)} s, QA ${qa.score}/100)`,
      data: { issues: qa.issues },
    });

    return updated;
  } catch (err) {
    await prisma.clip.update({
      where: { id: clip.id },
      data: { status: "FAILED", renderLog: (err as Error).message },
    });
    await logEvent({
      stage: "render",
      entity: `clip:${clip.id}`,
      level: "error",
      message: `Rendu échoué : ${(err as Error).message}`,
    });
    throw err;
  }
}

/**
 * Le clipper dépose sa version montée à la main : nouvelle révision,
 * chaînée au brouillon auto qu'elle remplace.
 */
export async function submitClipperVersion(args: {
  baseClipId: string;
  clipperId: string;
  filePath: string;
  title?: string;
  caption?: string;
  hashtags?: string[];
  note?: string;
}): Promise<Clip> {
  const base = await prisma.clip.findUniqueOrThrow({
    where: { id: args.baseClipId },
    include: { rush: { include: { campaign: true } }, hook: true },
  });

  const { probeMedia } = await import("../render/ffmpeg");
  const probe = await probeMedia(args.filePath);

  const qa = qaCheck({
    durationSec: probe.durationSec,
    hook: base.hook?.text ?? base.caption,
    width: probe.width,
    height: probe.height,
    minSeconds: base.rush.campaign?.minClipSeconds ?? 15,
    maxSeconds: base.rush.campaign?.maxClipSeconds ?? 75,
  });

  const clip = await prisma.clip.create({
    data: {
      rushId: base.rushId,
      campaignId: base.campaignId,
      momentId: base.momentId,
      hookId: base.hookId,
      clipperId: args.clipperId,
      assignmentId: base.assignmentId,
      title: args.title ?? base.title,
      caption: args.caption ?? base.caption,
      hashtags: args.hashtags ?? base.hashtags,
      origin: "CLIPPER",
      version: base.version + 1,
      replacesId: base.id,
      filePath: args.filePath,
      publicUrl: publicUrlFor(args.filePath),
      durationSec: probe.durationSec,
      width: probe.width,
      height: probe.height,
      sizeBytes: probe.sizeBytes ? BigInt(probe.sizeBytes) : null,
      startSec: base.startSec,
      endSec: base.endSec,
      status: "SUBMITTED",
      submittedAt: new Date(),
      qaScore: qa.score,
      qaIssues: qa.issues,
      renderRecipe: { source: "clipper-upload", file: path.basename(args.filePath), note: args.note } as never,
    },
  });

  // Le brouillon auto reste en base, marqué comme remplacé.
  await prisma.clip.update({ where: { id: base.id }, data: { status: "CHANGES_REQUESTED" } });

  const profile = await prisma.clipperProfile.findUnique({ where: { userId: args.clipperId } });
  if (profile) {
    const assignment = base.assignmentId
      ? await prisma.assignment.findUnique({ where: { id: base.assignmentId } })
      : null;
    const onTime = assignment?.dueAt ? new Date() <= assignment.dueAt : true;
    const turnaroundH = assignment
      ? (Date.now() - assignment.createdAt.getTime()) / 36e5
      : profile.medianTurnaroundH;

    const submitted = profile.clipsSubmitted + 1;
    await prisma.clipperProfile.update({
      where: { id: profile.id },
      data: {
        clipsSubmitted: submitted,
        lastClipAt: new Date(),
        // Moyenne glissante simple : suffisant et lisible.
        medianTurnaroundH: Number(
          ((profile.medianTurnaroundH * profile.clipsSubmitted + turnaroundH) / submitted).toFixed(2),
        ),
        onTimeRate: Number(
          (((profile.onTimeRate / 100) * profile.clipsSubmitted + (onTime ? 1 : 0)) / submitted * 100).toFixed(2),
        ),
      },
    });
  }

  if (base.assignmentId) {
    await prisma.assignment.update({
      where: { id: base.assignmentId },
      data: { status: "SUBMITTED", submittedAt: new Date() },
    });
  }

  await logEvent({
    stage: "render",
    entity: `clip:${clip.id}`,
    message: `Version clipper v${clip.version} déposée (QA ${qa.score}/100)`,
    data: { replaces: base.id, issues: qa.issues },
  });

  return clip;
}

/** Validation ou refus d'un clip, avec mise à jour du score du clipper. */
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
    args.decision === "APPROVED" ? "APPROVED" : args.decision === "REJECTED" ? "REJECTED" : "CHANGES_REQUESTED";

  const updated = await prisma.clip.update({
    where: { id: clip.id },
    data: { status, approvedAt: args.decision === "APPROVED" ? new Date() : null },
  });

  if (clip.clipperId) {
    const profile = await prisma.clipperProfile.findUnique({ where: { userId: clip.clipperId } });
    if (profile) {
      const approved = profile.clipsApproved + (args.decision === "APPROVED" ? 1 : 0);
      const rejected = profile.clipsRejected + (args.decision === "REJECTED" ? 1 : 0);
      const recomputed = scoreClipper({
        clipsSubmitted: profile.clipsSubmitted,
        clipsApproved: approved,
        clipsPublished: profile.clipsPublished,
        totalViews: profile.totalViews,
        onTimeRate: profile.onTimeRate,
        medianTurnaroundH: profile.medianTurnaroundH,
        lastClipAt: profile.lastClipAt,
      });
      await prisma.clipperProfile.update({
        where: { id: profile.id },
        data: {
          clipsApproved: approved,
          clipsRejected: rejected,
          approvalRate: profile.clipsSubmitted ? (approved / profile.clipsSubmitted) * 100 : 0,
          score: recomputed.score,
          tier: recomputed.tier,
          scoreBreakdown: recomputed as never,
        },
      });
    }
  }

  await logEvent({
    stage: "review",
    entity: `clip:${clip.id}`,
    message: `Clip ${args.decision === "APPROVED" ? "validé" : args.decision === "REJECTED" ? "refusé" : "renvoyé pour corrections"}`,
    data: { comment: args.comment },
  });

  return updated;
}
