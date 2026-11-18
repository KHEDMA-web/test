/**
 * File de publication.
 *
 * Un clip validé produit une `Publication` par réseau. La file est
 * rejouable : chaque tentative incrémente `attempts`, les erreurs non
 * récupérables (400/401/403) sont marquées FAILED sans réessai, les erreurs
 * réseau et 5xx restent QUEUED pour la passe suivante.
 */
import { prisma } from "../db";
import { logEvent } from "../log";
import { config } from "../config";
import { toMetricoolLocal } from "../utils";
import { metricool, MetricoolError, type MetricoolNetwork } from "./client";
import type { Publication } from "@prisma/client";

export const MAX_ATTEMPTS = 4;

/** Options par réseau que Metricool attend dans un bloc dédié. */
export function networkDataFor(network: MetricoolNetwork, isVideo: boolean): Record<string, unknown> {
  switch (network) {
    case "instagram":
      return { instagramData: { type: isVideo ? "REEL" : "POST" } };
    case "facebook":
      return { facebookData: { type: isVideo ? "REEL" : "POST" } };
    case "youtube":
      return { youtubeData: { type: "SHORT", privacy: "public" } };
    case "tiktok":
      return { tiktokData: { privacyLevel: "PUBLIC_TO_EVERYONE", disableComment: false } };
    case "linkedin":
      return { linkedinData: { type: "POST" } };
    case "pinterest":
      return { pinterestData: { type: "PIN" } };
    default:
      return {};
  }
}

export type QueueInput = {
  clipId: string;
  networks: MetricoolNetwork[];
  scheduledAt: Date;
  /** Décalage entre deux réseaux, pour ne pas tout publier à la seconde près. */
  staggerMinutes?: number;
  blogId?: string;
  timezone?: string;
  text?: string;
  firstComment?: string;
  autoPublish?: boolean;
  draft?: boolean;
};

/** Crée les publications en file pour un clip validé. */
export async function queueClipPublications(input: QueueInput): Promise<Publication[]> {
  const clip = await prisma.clip.findUniqueOrThrow({
    where: { id: input.clipId },
    include: { campaign: true, hook: true },
  });

  if (!["APPROVED", "SCHEDULED", "READY"].includes(clip.status)) {
    throw new Error(
      `Le clip doit être validé avant publication (statut actuel : ${clip.status}).`,
    );
  }
  if (!clip.publicUrl) {
    throw new Error("Le clip n'a pas d'URL publique : Metricool exige un média accessible et non expirant.");
  }

  const timezone = input.timezone ?? config.metricool.timezone;
  const blogId = input.blogId ?? clip.campaign?.metricoolBlogId ?? config.metricool.blogId ?? "";
  const baseText = input.text ?? clip.caption ?? clip.hook?.text ?? clip.title;
  const text = [baseText, clip.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")]
    .filter(Boolean)
    .join("\n\n");

  const stagger = input.staggerMinutes ?? 7;
  const created: Publication[] = [];

  for (const [i, network] of input.networks.entries()) {
    const when = new Date(input.scheduledAt.getTime() + i * stagger * 60_000);
    const pub = await prisma.publication.create({
      data: {
        clipId: clip.id,
        network,
        blogId,
        text,
        firstComment: input.firstComment,
        scheduledAt: when,
        scheduledAtLocal: toMetricoolLocal(when, timezone),
        timezone,
        autoPublish: input.autoPublish ?? true,
        draft: input.draft ?? false,
        networkData: networkDataFor(network, true) as never,
        mediaUrl: clip.publicUrl,
        status: "QUEUED",
      },
    });
    created.push(pub);
  }

  await prisma.clip.update({ where: { id: clip.id }, data: { status: "SCHEDULED" } });
  await logEvent({
    stage: "publish",
    entity: `clip:${clip.id}`,
    message: `${created.length} publication(s) en file : ${input.networks.join(", ")}`,
    data: { scheduledAt: input.scheduledAt.toISOString(), blogId },
  });

  return created;
}

/** Envoie une publication à Metricool. Ne lève pas : le statut porte le résultat. */
export async function pushPublication(publicationId: string): Promise<Publication> {
  const pub = await prisma.publication.findUniqueOrThrow({ where: { id: publicationId } });

  if (pub.status === "PUBLISHED" || pub.status === "SCHEDULED") return pub;
  if (pub.attempts >= MAX_ATTEMPTS) {
    return prisma.publication.update({
      where: { id: pub.id },
      data: { status: "FAILED", lastError: `Abandon après ${pub.attempts} tentatives.` },
    });
  }

  await prisma.publication.update({
    where: { id: pub.id },
    data: { status: "SCHEDULING", attempts: { increment: 1 } },
  });

  try {
    // Metricool refuse une date passée : si la file a pris du retard,
    // on repousse au prochain créneau plutôt que de perdre le clip.
    let when = pub.scheduledAt;
    let localTime = pub.scheduledAtLocal;
    if (when.getTime() <= Date.now() + 60_000) {
      when = new Date(Date.now() + 5 * 60_000);
      localTime = toMetricoolLocal(when, pub.timezone);
    }

    const { id, raw, payload } = await metricool.schedulePost({
      dateTimeLocal: localTime,
      timezone: pub.timezone,
      text: pub.text,
      networks: [pub.network as MetricoolNetwork],
      blogId: pub.blogId || undefined,
      mediaUrl: pub.mediaUrl,
      mediaId: pub.mediaId,
      autoPublish: pub.autoPublish,
      draft: pub.draft,
      firstCommentText: pub.firstComment,
      networkData: (pub.networkData as Record<string, unknown>) ?? undefined,
    });

    const updated = await prisma.publication.update({
      where: { id: pub.id },
      data: {
        status: "SCHEDULED",
        metricoolPostId: id,
        metricoolRaw: raw as never,
        requestPayload: payload as never,
        scheduledAt: when,
        scheduledAtLocal: localTime,
        lastError: null,
      },
    });

    await logEvent({
      stage: "publish",
      entity: `publication:${pub.id}`,
      message: `Planifié sur ${pub.network} via Metricool (${metricool.mode()}) — post ${id ?? "sans id"}`,
      data: { scheduledAtLocal: localTime, timezone: pub.timezone },
    });

    return updated;
  } catch (err) {
    const isMetricool = err instanceof MetricoolError;
    const retryable = isMetricool ? err.retryable : true;
    const attempts = pub.attempts + 1;
    const giveUp = !retryable || attempts >= MAX_ATTEMPTS;

    const updated = await prisma.publication.update({
      where: { id: pub.id },
      data: {
        status: giveUp ? "FAILED" : "QUEUED",
        lastError: (err as Error).message,
      },
    });

    await logEvent({
      stage: "publish",
      entity: `publication:${pub.id}`,
      level: "error",
      message: `Échec ${pub.network} (tentative ${attempts}/${MAX_ATTEMPTS})${giveUp ? ", abandon" : ", sera rejoué"} : ${(err as Error).message}`,
    });

    return updated;
  }
}

/** Passe de traitement : à appeler par un cron ou le bouton « Traiter la file ». */
export async function processQueue(limit = 20): Promise<{
  processed: number;
  scheduled: number;
  failed: number;
}> {
  const pending = await prisma.publication.findMany({
    where: { status: "QUEUED", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { scheduledAt: "asc" },
    take: limit,
  });

  let scheduled = 0;
  let failed = 0;
  for (const p of pending) {
    const res = await pushPublication(p.id);
    if (res.status === "SCHEDULED") scheduled += 1;
    if (res.status === "FAILED") failed += 1;
  }

  // Un clip dont toutes les publications sont planifiées passe à PUBLISHED
  // dès que leur heure est atteinte (Metricool publie de son côté).
  const due = await prisma.publication.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: new Date() } },
    select: { id: true, clipId: true },
  });
  if (due.length) {
    await prisma.publication.updateMany({
      where: { id: { in: due.map((d) => d.id) } },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    await prisma.clip.updateMany({
      where: { id: { in: [...new Set(due.map((d) => d.clipId))] } },
      data: { status: "PUBLISHED" },
    });
  }

  return { processed: pending.length, scheduled, failed };
}
