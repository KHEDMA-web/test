"use server";

/**
 * Actions serveur appelées depuis les formulaires de l'UI.
 * Les intégrations entrantes (webhook Whop, médias, cron) passent par
 * des routes API, pas par ces actions.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { syncAllMemberships, recomputeClipperScores } from "@/lib/whop/sync";
import { transcribeRush, detectRushMoments, ingestRush } from "@/lib/pipeline/ingest";
import { renderAutoDraft, reviewClip } from "@/lib/pipeline/clips";
import { assignRush } from "@/lib/pipeline/assign";
import { queueClipPublications, processQueue } from "@/lib/metricool/publish";
import { runFullPipeline } from "@/lib/pipeline/orchestrator";
import { generateTestRush } from "@/lib/render/ffmpeg";
import { ensureStorage, storagePath, saveUpload } from "@/lib/storage";
import { submitClipperVersion } from "@/lib/pipeline/clips";
import type { MetricoolNetwork } from "@/lib/metricool/client";

export async function syncWhopAction() {
  await syncAllMemberships();
  await recomputeClipperScores();
  revalidatePath("/recruitment");
  revalidatePath("/");
}

export async function decideApplicationAction(formData: FormData) {
  const id = String(formData.get("applicationId"));
  const decision = String(formData.get("decision")) as "ACCEPTED" | "REJECTED" | "SHORTLISTED";

  const application = await prisma.application.update({
    where: { id },
    data: { status: decision, reviewedAt: new Date() },
  });

  // Accepter une candidature ouvre l'accès : le profil de clipper est créé.
  if (decision === "ACCEPTED" && application.userId) {
    await prisma.clipperProfile.upsert({
      where: { userId: application.userId },
      create: {
        userId: application.userId,
        score: Math.round(application.score * 0.6),
        niches: application.niches,
        languages: application.languages.length ? application.languages : ["fr"],
        tools: application.editingTools,
        portfolio: application.portfolioUrls,
        activeSince: new Date(),
      },
      update: { blocked: false },
    });
  }
  if (decision === "REJECTED" && application.userId) {
    await prisma.clipperProfile.updateMany({ where: { userId: application.userId }, data: { blocked: true } });
  }

  revalidatePath("/recruitment");
}

export async function transcribeRushAction(formData: FormData) {
  const rushId = String(formData.get("rushId"));
  await transcribeRush(rushId);
  revalidatePath(`/rushes/${rushId}`);
  revalidatePath("/rushes");
}

export async function detectMomentsAction(formData: FormData) {
  const rushId = String(formData.get("rushId"));
  await detectRushMoments(rushId);
  revalidatePath(`/rushes/${rushId}`);
}

export async function renderDraftAction(formData: FormData) {
  const momentId = String(formData.get("momentId"));
  const hookId = formData.get("hookId") ? String(formData.get("hookId")) : undefined;
  const framing = (formData.get("framing") as "cover" | "fit-blur" | "fit-bars" | null) ?? undefined;
  const clip = await renderAutoDraft(momentId, { hookId, framing });
  revalidatePath("/studio");
  revalidatePath(`/studio/${clip.id}`);
  revalidatePath(`/rushes`);
}

export async function selectHookAction(formData: FormData) {
  const hookId = String(formData.get("hookId"));
  const momentId = String(formData.get("momentId"));
  await prisma.$transaction([
    prisma.hook.updateMany({ where: { momentId }, data: { selected: false } }),
    prisma.hook.update({ where: { id: hookId }, data: { selected: true } }),
  ]);
  revalidatePath("/studio");
  revalidatePath(`/rushes`);
}

export async function reviewClipAction(formData: FormData) {
  const clipId = String(formData.get("clipId"));
  const decision = String(formData.get("decision")) as "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";
  const comment = formData.get("comment") ? String(formData.get("comment")) : undefined;
  await reviewClip({ clipId, decision, comment });
  revalidatePath("/review");
  revalidatePath("/studio");
}

export async function uploadClipperVersionAction(formData: FormData) {
  const baseClipId = String(formData.get("baseClipId"));
  const clipperId = String(formData.get("clipperId"));
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) throw new Error("Aucun fichier reçu.");

  await ensureStorage();
  const path = await saveUpload("clip", file.name, await file.arrayBuffer());
  await submitClipperVersion({
    baseClipId,
    clipperId,
    filePath: path,
    caption: formData.get("caption") ? String(formData.get("caption")) : undefined,
    note: formData.get("note") ? String(formData.get("note")) : undefined,
  });
  revalidatePath("/studio");
  revalidatePath("/review");
}

export async function assignRushAction(formData: FormData) {
  const rushId = String(formData.get("rushId"));
  const clipperId = formData.get("clipperId") ? String(formData.get("clipperId")) : undefined;
  await assignRush({ rushId, clipperId });
  revalidatePath(`/rushes/${rushId}`);
  revalidatePath("/recruitment");
}

export async function schedulePublicationAction(formData: FormData) {
  const clipId = String(formData.get("clipId"));
  const networks = formData.getAll("networks").map(String) as MetricoolNetwork[];
  const when = String(formData.get("scheduledAt"));
  const scheduledAt = when ? new Date(when) : new Date(Date.now() + 2 * 3600_000);

  await queueClipPublications({
    clipId,
    networks: networks.length ? networks : ["instagram", "tiktok"],
    scheduledAt,
    text: formData.get("text") ? String(formData.get("text")) : undefined,
  });
  revalidatePath("/publishing");
  revalidatePath("/review");
}

export async function processQueueAction() {
  await processQueue(50);
  revalidatePath("/publishing");
  revalidatePath("/");
}

/** Crée un rush de démonstration et le passe dans tout le pipeline. */
export async function runDemoPipelineAction(formData: FormData) {
  const campaignId = formData.get("campaignId") ? String(formData.get("campaignId")) : null;
  const title = formData.get("title") ? String(formData.get("title")) : `Rush de test ${new Date().toLocaleString("fr-FR")}`;

  await ensureStorage();
  const file = storagePath("rush", `demo-${Date.now()}.mp4`);
  await generateTestRush(file, 180);

  await runFullPipeline(
    { title, campaignId, filePath: file, language: "fr" },
    { draftCount: 2, assign: true, autoApprove: false, publish: false },
  );

  revalidatePath("/rushes");
  revalidatePath("/");
  revalidatePath("/studio");
}

export async function ingestUrlAction(formData: FormData) {
  const sourceUrl = String(formData.get("sourceUrl"));
  const title = String(formData.get("title") || "Rush importé");
  const campaignId = formData.get("campaignId") ? String(formData.get("campaignId")) : null;

  await ingestRush({ title, sourceUrl, campaignId, language: "fr" });
  revalidatePath("/rushes");
}
