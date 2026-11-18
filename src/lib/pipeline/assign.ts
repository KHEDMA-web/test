/**
 * Attribution : relie l'étage 1 (les clippers recrutés sur Whop) à
 * l'étage 4 (le montage). Classe les clippers disponibles pour un rush
 * donné et crée les missions.
 */
import { prisma } from "../db";
import { logEvent } from "../log";
import { matchClipperToRush, type MatchResult } from "../whop/recruiting";

export type Ranked = {
  clipperId: string;
  userId: string;
  name: string;
  tier: string;
  score: number;
  match: MatchResult;
};

/** Classe les clippers pour un rush, du plus adapté au moins adapté. */
export async function rankClippersForRush(rushId: string): Promise<Ranked[]> {
  const rush = await prisma.rush.findUniqueOrThrow({
    where: { id: rushId },
    include: { campaign: true },
  });

  const profiles = await prisma.clipperProfile.findMany({
    where: { blocked: false },
    include: { user: true },
  });

  const openCounts = await prisma.assignment.groupBy({
    by: ["clipperId"],
    where: { status: { in: ["OPEN", "IN_PROGRESS"] } },
    _count: { _all: true },
  });
  const loadMap = new Map(openCounts.map((c) => [c.clipperId, c._count._all]));

  // La campagne porte les niches visées ; à défaut, celles des clippers
  // ne sont pas discriminantes et le score se joue sur l'historique.
  const targetNiches = rush.campaign
    ? [...new Set(profiles.flatMap((p) => p.niches))].slice(0, 4)
    : [];

  return profiles
    .map((p) => ({
      clipperId: p.id,
      userId: p.userId,
      name: p.user.name,
      tier: p.tier,
      score: p.score,
      match: matchClipperToRush({
        clipper: {
          id: p.id,
          name: p.user.name,
          score: p.score,
          tier: p.tier,
          niches: p.niches,
          languages: p.languages,
          openAssignments: loadMap.get(p.id) ?? 0,
          medianTurnaroundH: p.medianTurnaroundH,
        },
        campaign: { targetNiches, language: rush.language },
      }),
    }))
    .sort((a, b) => b.match.score - a.match.score);
}

/** Crée une mission pour le clipper le plus adapté (ou un clipper imposé). */
export async function assignRush(args: {
  rushId: string;
  clipperId?: string;
  momentIds?: string[];
  quota?: number;
  dueInHours?: number;
}) {
  const rush = await prisma.rush.findUniqueOrThrow({ where: { id: args.rushId } });
  if (!rush.campaignId) throw new Error("Le rush doit appartenir à une campagne pour être attribué.");

  const ranked = await rankClippersForRush(args.rushId);
  const chosen = args.clipperId
    ? ranked.find((r) => r.clipperId === args.clipperId)
    : ranked.find((r) => r.match.score > 0);

  if (!chosen) throw new Error("Aucun clipper disponible : tous saturés ou bloqués.");

  const moments = args.momentIds?.length
    ? args.momentIds
    : (
        await prisma.moment.findMany({
          where: { rushId: args.rushId, status: { in: ["SELECTED", "CANDIDATE"] } },
          orderBy: { score: "desc" },
          take: args.quota ?? 3,
          select: { id: true },
        })
      ).map((m) => m.id);

  const assignment = await prisma.assignment.create({
    data: {
      campaignId: rush.campaignId,
      clipperId: chosen.clipperId,
      rushId: args.rushId,
      momentIds: moments,
      quota: args.quota ?? moments.length,
      dueAt: new Date(Date.now() + (args.dueInHours ?? 48) * 36e5),
      matchScore: chosen.match.score,
      matchReason: chosen.match.reason,
      status: "OPEN",
    },
  });

  await logEvent({
    stage: "whop",
    entity: `assignment:${assignment.id}`,
    message: `Rush attribué à ${chosen.name} (adéquation ${chosen.match.score}/100)`,
    data: { reason: chosen.match.reason, moments: moments.length },
  });

  return { assignment, chosen, ranked };
}
