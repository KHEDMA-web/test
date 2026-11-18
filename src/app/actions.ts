"use server";

/**
 * Actions serveur appelées depuis les formulaires.
 * Les entrées externes (webhook Whop, médias, cron, API de plans) passent
 * par des routes, pas par ces actions.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { syncAllMemberships, resetMonthlyQuotas } from "@/lib/whop/sync";
import { transcribeRush, detectRushMoments, ingestRush, ingestFromLink } from "@/lib/pipeline/ingest";
import { renderPlan, autoPlanFromMoment, reviewClip } from "@/lib/pipeline/clips";
import { createPlansFromInput } from "@/lib/pipeline/editPlan";
import { prepareRush } from "@/lib/pipeline/orchestrator";
import { queueClipPublications, processQueue } from "@/lib/metricool/publish";
import { deliverClip } from "@/lib/delivery/drive";
import { generateTestRush } from "@/lib/render/ffmpeg";
import { ensureStorage, storagePath, saveUpload } from "@/lib/storage";
import type { MetricoolNetwork } from "@/lib/metricool/client";
import type { ClientStatus, RushOrigin } from "@prisma/client";

// ── Étage 1 : clients ───────────────────────────────────────

export async function syncWhopAction() {
  await syncAllMemberships();
  revalidatePath("/clients");
  revalidatePath("/");
}

export async function resetQuotasAction() {
  await resetMonthlyQuotas();
  revalidatePath("/clients");
}

export async function decideClientAction(formData: FormData) {
  const id = String(formData.get("clientId"));
  const decision = String(formData.get("decision"));

  const status: ClientStatus =
    decision === "prendre" ? "ACTIVE" : decision === "refuser" ? "DECLINED" : "PROSPECT";

  await prisma.client.update({
    where: { id },
    data: {
      status,
      decision,
      qualifiedAt: new Date(),
      startedAt: decision === "prendre" ? new Date() : undefined,
    },
  });
  revalidatePath("/clients");
}

export async function updateClientBriefAction(formData: FormData) {
  const id = String(formData.get("clientId"));
  const num = (k: string, fallback: number) => {
    const v = Number(formData.get(k));
    return Number.isFinite(v) && v > 0 ? Math.round(v) : fallback;
  };
  const existing = await prisma.client.findUniqueOrThrow({ where: { id } });

  await prisma.client.update({
    where: { id },
    data: {
      brief: String(formData.get("brief") ?? ""),
      hookGuidelines: String(formData.get("hookGuidelines") ?? ""),
      brandVoice: String(formData.get("brandVoice") ?? ""),
      avoid: String(formData.get("avoid") ?? ""),
      minClipSeconds: num("minClipSeconds", existing.minClipSeconds),
      maxClipSeconds: num("maxClipSeconds", existing.maxClipSeconds),
      clipsPerRush: num("clipsPerRush", existing.clipsPerRush),
      metricoolBlogId: String(formData.get("metricoolBlogId") ?? "") || null,
      targetNetworks: formData.getAll("targetNetworks").map(String),
    },
  });
  revalidatePath("/clients");
}

// ── Étage 2 : rushes ────────────────────────────────────────

export async function ingestUrlAction(formData: FormData) {
  const sourceUrl = String(formData.get("sourceUrl"));
  const title = String(formData.get("title") || "Rush importé");
  const clientId = formData.get("clientId") ? String(formData.get("clientId")) : null;
  const origin = (String(formData.get("origin") || "CLIENT_UPLOAD") as RushOrigin);

  const rush = await ingestRush({ title, sourceUrl, clientId, language: "fr", origin });
  revalidatePath("/rushes");
  redirect(`/rushes/${rush.id}`);
}

/**
 * Import d'un lien : VOD YouTube, rediffusion ou direct Twitch, ou tout
 * site connu de yt-dlp. Un direct en cours est capturé à partir de
 * maintenant, puisqu'on ne peut pas remonter son passé.
 */
export async function ingestLinkAction(formData: FormData) {
  const url = String(formData.get("url") ?? "").trim();
  if (!url) throw new Error("Aucun lien fourni.");

  const num = (k: string): number | undefined => {
    const raw = formData.get(k);
    if (raw === null || String(raw).trim() === "") return undefined;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : undefined;
  };

  const minutes = num("recordMinutes");
  let rushId: string;
  try {
    const { rush } = await ingestFromLink({
      url,
      clientId: formData.get("clientId") ? String(formData.get("clientId")) : null,
      title: formData.get("title") ? String(formData.get("title")) : undefined,
      startSec: num("startSec"),
      endSec: num("endSec"),
      recordSeconds: minutes ? Math.round(minutes * 60) : undefined,
      maxHeight: num("maxHeight"),
    });
    rushId = rush.id;
  } catch (err) {
    // Le motif doit rester lisible dans le journal : lien privé, playlist,
    // vérification YouTube, direct terminé…
    await prisma.pipelineEvent.create({
      data: {
        stage: "ingest",
        entity: `source:${url.slice(0, 120)}`,
        level: "error",
        message: (err as Error).message,
      },
    });
    revalidatePath("/rushes");
    return;
  }

  revalidatePath("/rushes");
  redirect(`/rushes/${rushId}`);
}

export async function uploadRushAction(formData: FormData) {
  const file = formData.get("file") as File | null;
  if (!file || file.size === 0) throw new Error("Aucun fichier reçu.");
  const clientId = formData.get("clientId") ? String(formData.get("clientId")) : null;
  const title = String(formData.get("title") || file.name);

  await ensureStorage();
  const filePath = await saveUpload("rush", file.name, await file.arrayBuffer());
  const rush = await ingestRush({ title, filePath, clientId, language: "fr", origin: "CLIENT_UPLOAD" });
  revalidatePath("/rushes");
  redirect(`/rushes/${rush.id}`);
}

/** Rush de démonstration généré avec ffmpeg, passé jusqu'au brief. */
export async function demoRushAction(formData: FormData) {
  const clientId = formData.get("clientId") ? String(formData.get("clientId")) : null;
  await ensureStorage();
  const file = storagePath("rush", `demo-${Date.now()}.mp4`);
  await generateTestRush(file, 200);

  const report = await prepareRush({
    title: `Rush de test — ${new Date().toLocaleString("fr-FR")}`,
    clientId,
    filePath: file,
    language: "fr",
    origin: "SOURCED",
  });
  revalidatePath("/rushes");
  revalidatePath("/");
  redirect(`/rushes/${report.rushId}`);
}

export async function transcribeRushAction(formData: FormData) {
  const rushId = String(formData.get("rushId"));
  await transcribeRush(rushId);
  revalidatePath(`/rushes/${rushId}`);
}

export async function detectMomentsAction(formData: FormData) {
  const rushId = String(formData.get("rushId"));
  await detectRushMoments(rushId);
  revalidatePath(`/rushes/${rushId}`);
}

// ── Étage 4 : montage ───────────────────────────────────────

/** Collage de la réponse de Claude. Enregistre les plans et les rend. */
export async function submitPlanAction(formData: FormData) {
  const rushId = String(formData.get("rushId"));
  const raw = String(formData.get("plan") ?? "");
  const renderNow = formData.get("renderNow") === "on";

  if (!raw.trim()) {
    await prisma.pipelineEvent.create({
      data: { stage: "plan", entity: `rush:${rushId}`, level: "warn", message: "Collage vide ignoré." },
    });
    revalidatePath(`/rushes/${rushId}/montage`);
    return;
  }

  const result = await createPlansFromInput({ rushId, raw, source: "CLAUDE_CHAT", author: "Claude (chat)" });

  // Le compte rendu de lecture est journalisé : il reste consultable même
  // après rechargement de la page.
  await prisma.pipelineEvent.create({
    data: {
      stage: "plan",
      entity: `rush:${rushId}`,
      level: result.ok ? "info" : "error",
      message: result.ok
        ? `${result.created.length} plan(s) enregistré(s) depuis le chat`
        : `Plan refusé : ${result.issues.filter((i) => i.level === "error")[0]?.message ?? "format invalide"}`,
      data: { issues: result.issues, note: result.note } as never,
    },
  });

  if (renderNow) {
    for (const planId of result.created) {
      try {
        await renderPlan(planId);
      } catch {
        // L'erreur est déjà journalisée et portée par le plan.
      }
    }
  }

  revalidatePath(`/rushes/${rushId}/montage`);
  revalidatePath("/montage");
  revalidatePath("/review");
}

export async function renderPlanAction(formData: FormData) {
  const planId = String(formData.get("planId"));
  const plan = await prisma.editPlan.findUniqueOrThrow({ where: { id: planId } });
  try {
    await renderPlan(planId);
  } catch {
    // Statut et message d'erreur sont portés par le plan.
  }
  revalidatePath(`/rushes/${plan.rushId}/montage`);
  revalidatePath("/montage");
  revalidatePath("/review");
}

export async function autoPlanAction(formData: FormData) {
  const momentId = String(formData.get("momentId"));
  const hookId = formData.get("hookId") ? String(formData.get("hookId")) : undefined;
  const planId = await autoPlanFromMoment(momentId, hookId);
  await renderPlan(planId).catch(() => undefined);
  const moment = await prisma.moment.findUniqueOrThrow({ where: { id: momentId } });
  revalidatePath(`/rushes/${moment.rushId}/montage`);
  revalidatePath("/montage");
}

export async function deletePlanAction(formData: FormData) {
  const planId = String(formData.get("planId"));
  const plan = await prisma.editPlan.findUniqueOrThrow({ where: { id: planId } });
  await prisma.editPlan.delete({ where: { id: planId } });
  revalidatePath(`/rushes/${plan.rushId}/montage`);
  revalidatePath("/montage");
}

export async function selectHookAction(formData: FormData) {
  const hookId = String(formData.get("hookId"));
  const momentId = String(formData.get("momentId"));
  await prisma.$transaction([
    prisma.hook.updateMany({ where: { momentId }, data: { selected: false } }),
    prisma.hook.update({ where: { id: hookId }, data: { selected: true } }),
  ]);
  revalidatePath("/rushes");
}

// ── Relecture et publication ────────────────────────────────

export async function reviewClipAction(formData: FormData) {
  const clipId = String(formData.get("clipId"));
  const decision = String(formData.get("decision")) as "APPROVED" | "REJECTED" | "CHANGES_REQUESTED";
  const comment = formData.get("comment") ? String(formData.get("comment")) : undefined;
  await reviewClip({ clipId, decision, comment });
  revalidatePath("/review");
  revalidatePath("/montage");
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

export async function deliverClipAction(formData: FormData) {
  const clipId = String(formData.get("clipId"));
  try {
    await deliverClip(clipId);
  } catch (err) {
    // L'échec est journalisé et porté par la livraison : l'interface le lit.
    await prisma.pipelineEvent.create({
      data: {
        stage: "deliver",
        entity: `clip:${clipId}`,
        level: "error",
        message: (err as Error).message,
      },
    });
  }
  revalidatePath(`/clips/${clipId}`);
  revalidatePath("/settings");
}

export async function processQueueAction() {
  await processQueue(50);
  revalidatePath("/publishing");
  revalidatePath("/");
}
