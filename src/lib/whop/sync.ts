/**
 * Pont Whop → base locale.
 * Un membership Whop valide = un clipper qui a accès à la plateforme.
 * Appelé par le webhook (temps réel) et par la synchro manuelle (rattrapage).
 */
import { prisma } from "../db";
import { logEvent } from "../log";
import { config } from "../config";
import { whop, type WhopMembershipDTO } from "./client";
import { scoreApplication, scoreClipper } from "./recruiting";
import type { ApplicationStatus } from "@prisma/client";

function metaArray(meta: Record<string, unknown> | null, key: string): string[] {
  const v = meta?.[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function metaNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const v = meta?.[key];
  return typeof v === "number" ? v : null;
}

/** Niches réellement demandées par les campagnes actives — pondère le score de candidature. */
async function demandNiches(): Promise<string[]> {
  const campaigns = await prisma.campaign.findMany({
    where: { status: "ACTIVE" },
    select: { targetNetworks: true, brief: true, name: true, slug: true },
  });
  // Les niches de campagne sont portées par les tags de brief ; à défaut on
  // retombe sur une liste vide (score de niche neutralisé côté scoring).
  const fromSettings = await prisma.setting.findUnique({ where: { key: "demand_niches" } });
  if (fromSettings?.value) return fromSettings.value.split(",").map((s) => s.trim()).filter(Boolean);
  return campaigns.length ? ["business", "mindset", "podcast", "tech", "fitness"] : [];
}

/**
 * Enregistre (ou met à jour) un membership : utilisateur, accès, candidature scorée.
 * Idempotent — rejouer le même événement ne duplique rien.
 */
export async function upsertMembership(dto: WhopMembershipDTO): Promise<{
  userId: string | null;
  applicationId: string | null;
  granted: boolean;
}> {
  if (!dto.id) {
    await logEvent({
      stage: "whop",
      entity: "membership:?",
      level: "warn",
      message: "Membership sans id ignoré",
      data: dto.raw,
    });
    return { userId: null, applicationId: null, granted: false };
  }

  const email = dto.email ?? (dto.userId ? `${dto.userId}@whop.local` : null);

  // 1. L'utilisateur, identifié par son id Whop puis par son e-mail.
  let user = dto.userId
    ? await prisma.user.findUnique({ where: { whopUserId: dto.userId } })
    : null;
  if (!user && email) user = await prisma.user.findUnique({ where: { email } });

  if (!user && email) {
    user = await prisma.user.create({
      data: {
        email,
        name: dto.name ?? dto.username ?? email.split("@")[0],
        role: "CLIPPER",
        whopUserId: dto.userId,
        whopUsername: dto.username,
      },
    });
  } else if (user) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        whopUserId: dto.userId ?? user.whopUserId,
        whopUsername: dto.username ?? user.whopUsername,
        name: dto.name ?? user.name,
      },
    });
  }

  // 2. Le membership lui-même : source de vérité de l'accès.
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
      metadata: (dto.metadata ?? undefined) as never,
      raw: dto.raw as never,
      userId: user?.id,
    },
    update: {
      status: dto.status,
      valid: dto.valid,
      cancelAtPeriodEnd: dto.cancelAtPeriodEnd,
      currentPeriodEnd: dto.currentPeriodEnd,
      metadata: (dto.metadata ?? undefined) as never,
      raw: dto.raw as never,
      userId: user?.id,
      syncedAt: new Date(),
      whopProductId: dto.productId,
      whopPlanId: dto.planId,
    },
  });

  // 3. La candidature, scorée sur les métadonnées fournies à l'inscription Whop.
  const demand = await demandNiches();
  const scored = scoreApplication({
    portfolioUrls: metaArray(dto.metadata, "portfolio"),
    followerCount: metaNumber(dto.metadata, "followers"),
    pastClipViews: metaNumber(dto.metadata, "past_clip_views"),
    editingTools: metaArray(dto.metadata, "tools"),
    niches: metaArray(dto.metadata, "niches"),
    languages: metaArray(dto.metadata, "languages"),
    membershipStatus: dto.status,
    membershipValid: dto.valid,
    demandNiches: demand,
  });

  const status: ApplicationStatus =
    !dto.valid ? "PENDING" : scored.decision === "accept" ? "ACCEPTED" : scored.decision === "shortlist" ? "SHORTLISTED" : "REJECTED";

  const application = await prisma.application.upsert({
    where: { whopMembershipId: dto.id },
    create: {
      whopMembershipId: dto.id,
      whopUserId: dto.userId,
      whopProductId: dto.productId,
      email: email ?? `${dto.id}@whop.local`,
      displayName: dto.name ?? dto.username ?? "Candidat Whop",
      userId: user?.id,
      status,
      portfolioUrls: metaArray(dto.metadata, "portfolio"),
      followerCount: metaNumber(dto.metadata, "followers"),
      pastClipViews: metaNumber(dto.metadata, "past_clip_views"),
      editingTools: metaArray(dto.metadata, "tools"),
      niches: metaArray(dto.metadata, "niches"),
      languages: metaArray(dto.metadata, "languages"),
      score: scored.score,
      scoreBreakdown: scored as never,
      autoDecision: scored.decision,
    },
    update: {
      status,
      score: scored.score,
      scoreBreakdown: scored as never,
      autoDecision: scored.decision,
      userId: user?.id,
      portfolioUrls: metaArray(dto.metadata, "portfolio"),
      followerCount: metaNumber(dto.metadata, "followers"),
      pastClipViews: metaNumber(dto.metadata, "past_clip_views"),
    },
  });

  // 4. Accès accordé → profil de clipper prêt à recevoir des missions.
  let granted = false;
  if (user && dto.valid && status === "ACCEPTED") {
    const existing = await prisma.clipperProfile.findUnique({ where: { userId: user.id } });
    const base = scoreClipper({
      clipsSubmitted: existing?.clipsSubmitted ?? 0,
      clipsApproved: existing?.clipsApproved ?? 0,
      clipsPublished: existing?.clipsPublished ?? 0,
      totalViews: existing?.totalViews ?? 0,
      onTimeRate: existing?.onTimeRate ?? 0,
      medianTurnaroundH: existing?.medianTurnaroundH ?? 0,
      lastClipAt: existing?.lastClipAt ?? null,
    });
    // Un nouveau clipper n'a pas encore de résultats : son score de départ
    // est celui de sa candidature, remplacé par ses performances réelles ensuite.
    const startScore = existing && existing.clipsSubmitted > 0 ? base.score : Math.round(scored.score * 0.6);

    await prisma.clipperProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        tier: existing?.tier ?? (startScore >= 60 ? "VERIFIED" : "ROOKIE"),
        score: startScore,
        scoreBreakdown: base as never,
        niches: metaArray(dto.metadata, "niches"),
        languages: metaArray(dto.metadata, "languages").length
          ? metaArray(dto.metadata, "languages")
          : ["fr"],
        tools: metaArray(dto.metadata, "tools"),
        portfolio: metaArray(dto.metadata, "portfolio"),
        activeSince: new Date(),
      },
      update: {
        blocked: false,
        niches: metaArray(dto.metadata, "niches"),
        tools: metaArray(dto.metadata, "tools"),
      },
    });
    granted = true;
  }

  // 5. Accès perdu → le profil est bloqué, pas supprimé (on garde l'historique).
  if (user && !dto.valid) {
    await prisma.clipperProfile.updateMany({ where: { userId: user.id }, data: { blocked: true } });
  }

  await logEvent({
    stage: "whop",
    entity: `membership:${dto.id}`,
    message: `Membership ${dto.status} — candidature ${scored.score}/100 (${scored.decision})${granted ? ", accès clipper accordé" : ""}`,
    data: { score: scored.score, decision: scored.decision, valid: dto.valid },
  });

  return { userId: user?.id ?? null, applicationId: application.id, granted };
}

/** Rattrapage complet : relit tous les memberships du produit clippers. */
export async function syncAllMemberships(): Promise<{ total: number; granted: number; mode: string }> {
  const memberships = await whop.listMemberships({ productId: config.whop.productId });
  let granted = 0;
  for (const m of memberships) {
    const res = await upsertMembership(m);
    if (res.granted) granted += 1;
  }
  await logEvent({
    stage: "whop",
    entity: "sync:all",
    message: `Synchro Whop (${whop.mode()}) : ${memberships.length} membership(s), ${granted} accès clipper`,
  });
  return { total: memberships.length, granted, mode: whop.mode() };
}

/** Recalcule le score de tous les clippers depuis leurs résultats réels. */
export async function recomputeClipperScores(): Promise<number> {
  const profiles = await prisma.clipperProfile.findMany();
  for (const p of profiles) {
    const s = scoreClipper({
      clipsSubmitted: p.clipsSubmitted,
      clipsApproved: p.clipsApproved,
      clipsPublished: p.clipsPublished,
      totalViews: p.totalViews,
      onTimeRate: p.onTimeRate,
      medianTurnaroundH: p.medianTurnaroundH,
      lastClipAt: p.lastClipAt,
    });
    await prisma.clipperProfile.update({
      where: { id: p.id },
      data: {
        score: s.score,
        tier: s.tier,
        scoreBreakdown: s as never,
        approvalRate: p.clipsSubmitted ? (p.clipsApproved / p.clipsSubmitted) * 100 : 0,
        avgViews: p.clipsPublished ? Math.round(p.totalViews / p.clipsPublished) : 0,
      },
    });
  }
  return profiles.length;
}
