/**
 * Pont Whop → base locale.
 * Un abonnement Whop valide = un client qui paie pour du clipping.
 * Appelé par le webhook (temps réel) et par la synchro manuelle.
 */
import { prisma } from "../db";
import { logEvent } from "../log";
import { config } from "../config";
import { whop, type WhopMembershipDTO } from "./client";
import { qualifyClient } from "./qualify";
import type { ClientStatus, RushSourcing } from "@prisma/client";

function metaArray(meta: Record<string, unknown> | null, key: string): string[] {
  const v = meta?.[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function metaString(meta: Record<string, unknown> | null, key: string): string | null {
  const v = meta?.[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Statut client déduit du statut d'abonnement Whop. */
function statusFrom(dto: WhopMembershipDTO, decision: string): ClientStatus {
  if (dto.status === "past_due") return "PAST_DUE";
  if (!dto.valid) return dto.status === "canceled" ? "CHURNED" : "PROSPECT";
  if (decision === "refuser") return "DECLINED";
  // « À cadrer » n'ouvre pas la production : le dossier attend ma décision.
  if (decision === "discuter") return "PROSPECT";
  if (dto.status === "trialing") return "TRIAL";
  return "ACTIVE";
}

/** Mes niches de prédilection, utilisées pour pondérer l'adéquation. */
async function myNiches(): Promise<string[]> {
  const setting = await prisma.setting.findUnique({ where: { key: "my_niches" } });
  return setting?.value ? setting.value.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Enregistre ou met à jour un client depuis son abonnement Whop.
 * Idempotent : rejouer le même événement ne duplique rien.
 */
export async function upsertClientFromMembership(dto: WhopMembershipDTO): Promise<{
  clientId: string | null;
  decision: string;
  score: number;
}> {
  if (!dto.id) {
    await logEvent({
      stage: "whop",
      entity: "membership:?",
      level: "warn",
      message: "Abonnement sans identifiant, ignoré",
      data: dto.raw,
    });
    return { clientId: null, decision: "ignoré", score: 0 };
  }

  const email = dto.email ?? (dto.userId ? `${dto.userId}@whop.local` : `${dto.id}@whop.local`);
  const meta = dto.metadata;

  // L'utilisateur : identifié par son id Whop, puis par son e-mail.
  let user = dto.userId ? await prisma.user.findUnique({ where: { whopUserId: dto.userId } }) : null;
  if (!user) user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        name: dto.name ?? dto.username ?? email.split("@")[0],
        role: "CLIENT",
        whopUserId: dto.userId,
        whopUsername: dto.username,
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        whopUserId: dto.userId ?? user.whopUserId,
        whopUsername: dto.username ?? user.whopUsername,
        name: dto.name ?? user.name,
      },
    });
  }

  // L'abonnement : source de vérité du paiement.
  await prisma.whopMembership.upsert({
    where: { whopMembershipId: dto.id },
    create: {
      whopMembershipId: dto.id,
      whopUserId: dto.userId ?? "unknown",
      whopProductId: dto.productId,
      whopPlanId: dto.planId,
      accountId: dto.accountId,
      status: dto.status,
      valid: dto.valid,
      cancelAtPeriodEnd: dto.cancelAtPeriodEnd,
      currentPeriodEnd: dto.currentPeriodEnd,
      metadata: (meta ?? undefined) as never,
      raw: dto.raw as never,
      userId: user.id,
    },
    update: {
      status: dto.status,
      valid: dto.valid,
      cancelAtPeriodEnd: dto.cancelAtPeriodEnd,
      currentPeriodEnd: dto.currentPeriodEnd,
      metadata: (meta ?? undefined) as never,
      raw: dto.raw as never,
      userId: user.id,
      syncedAt: new Date(),
      whopProductId: dto.productId,
      whopPlanId: dto.planId,
    },
  });

  const clipsPerMonth = metaNumber(meta, "clips_per_month") ?? 8;
  const mrrCents = metaNumber(meta, "mrr_cents") ?? 0;
  const sourcing = (metaString(meta, "sourcing") as RushSourcing | null) ?? "CLIENT_PROVIDED";

  const qualified = qualifyClient({
    mrrCents,
    clipsPerMonth,
    backCatalogHours: metaNumber(meta, "back_catalog_hours"),
    sourcing,
    audienceSize: metaNumber(meta, "audience_size"),
    pastClipViews: metaNumber(meta, "past_clip_views"),
    brief: metaString(meta, "brief"),
    hookGuidelines: metaString(meta, "hook_guidelines"),
    niches: metaArray(meta, "niches"),
    targetNetworks: metaArray(meta, "networks"),
    membershipStatus: dto.status,
    membershipValid: dto.valid,
    myNiches: await myNiches(),
  });

  const status = statusFrom(dto, qualified.decision);

  // Les champs de brief ne sont écrasés que s'ils sont vides côté base :
  // ce que j'ai affiné à la main prime sur ce que Whop renvoie.
  const existing = await prisma.client.findUnique({ where: { whopMembershipId: dto.id } });

  const client = await prisma.client.upsert({
    where: { whopMembershipId: dto.id },
    create: {
      userId: user.id,
      name: dto.name ?? dto.username ?? "Client Whop",
      email,
      handle: dto.username,
      whopMembershipId: dto.id,
      whopUserId: dto.userId,
      whopProductId: dto.productId,
      whopPlanId: dto.planId,
      planName: metaString(meta, "plan_name"),
      status,
      valid: dto.valid,
      mrrCents,
      currentPeriodEnd: dto.currentPeriodEnd,
      startedAt: dto.valid ? new Date() : null,
      clipsPerMonth,
      sourcing,
      brief: metaString(meta, "brief"),
      hookGuidelines: metaString(meta, "hook_guidelines"),
      niches: metaArray(meta, "niches"),
      targetNetworks: metaArray(meta, "networks"),
      backCatalogHours: metaNumber(meta, "back_catalog_hours"),
      audienceSize: metaNumber(meta, "audience_size"),
      pastClipViews: metaNumber(meta, "past_clip_views"),
      score: qualified.score,
      scoreBreakdown: qualified as never,
      decision: qualified.decision,
      decisionNote: qualified.summary,
    },
    update: {
      status,
      valid: dto.valid,
      mrrCents,
      currentPeriodEnd: dto.currentPeriodEnd,
      planName: metaString(meta, "plan_name") ?? existing?.planName,
      clipsPerMonth,
      score: qualified.score,
      scoreBreakdown: qualified as never,
      decision: qualified.decision,
      decisionNote: qualified.summary,
      churnedAt: dto.valid ? null : (existing?.churnedAt ?? new Date()),
      brief: existing?.brief ?? metaString(meta, "brief"),
      hookGuidelines: existing?.hookGuidelines ?? metaString(meta, "hook_guidelines"),
      backCatalogHours: metaNumber(meta, "back_catalog_hours") ?? existing?.backCatalogHours,
      audienceSize: metaNumber(meta, "audience_size") ?? existing?.audienceSize,
      pastClipViews: metaNumber(meta, "past_clip_views") ?? existing?.pastClipViews,
    },
  });

  await logEvent({
    stage: "whop",
    entity: `client:${client.id}`,
    message: `${client.name} — abonnement ${dto.status}, qualification ${qualified.score}/100 (${qualified.decision}), ${(qualified.pricePerClipCents / 100).toFixed(0)} €/clip`,
    data: { decision: qualified.decision, mrrCents, clipsPerMonth },
  });

  return { clientId: client.id, decision: qualified.decision, score: qualified.score };
}

/** Rattrapage complet : relit tous les abonnements du produit de clipping. */
export async function syncAllMemberships(): Promise<{
  total: number;
  toTake: number;
  mode: string;
}> {
  const memberships = await whop.listMemberships({ productId: config.whop.productId });
  let toTake = 0;
  for (const m of memberships) {
    const res = await upsertClientFromMembership(m);
    if (res.decision === "prendre") toTake += 1;
  }
  await logEvent({
    stage: "whop",
    entity: "sync:all",
    message: `Synchro Whop (${whop.mode()}) : ${memberships.length} abonnement(s), ${toTake} client(s) à prendre`,
  });
  return { total: memberships.length, toTake, mode: whop.mode() };
}

/** Remet à zéro les compteurs de clips livrés (début de période). */
export async function resetMonthlyQuotas(): Promise<number> {
  const res = await prisma.client.updateMany({
    where: { status: { in: ["ACTIVE", "TRIAL"] } },
    data: { clipsDelivered: 0 },
  });
  await logEvent({ stage: "whop", entity: "quotas", message: `${res.count} quota(s) remis à zéro` });
  return res.count;
}
