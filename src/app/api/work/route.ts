/**
 * Le travail du jour : par quoi commencer, et pourquoi.
 * Première chose que le serveur MCP appelle pour s'orienter.
 */
import { prisma } from "@/lib/db";
import { json } from "@/lib/api";
import { productionPriority } from "@/lib/whop/qualify";
import { checkDeliveryTarget } from "@/lib/delivery/drive";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const [clients, rushes, pendingPlans, clipsToReview, approvedNotDelivered, failedPubs] = await Promise.all([
    prisma.client.findMany({
      where: { status: { in: ["ACTIVE", "TRIAL"] } },
      include: { rushes: { select: { dueAt: true }, orderBy: { dueAt: "asc" }, take: 1 } },
    }),
    prisma.rush.findMany({
      where: { transcriptStatus: "DONE" },
      include: {
        client: { select: { id: true, name: true, minClipSeconds: true, maxClipSeconds: true } },
        _count: { select: { editPlans: true, moments: true, clips: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.editPlan.findMany({
      where: { status: { in: ["DRAFT", "FAILED"] } },
      select: { id: true, title: true, rushId: true, status: true, error: true, warnings: true },
    }),
    prisma.clip.findMany({
      where: { status: "READY" },
      select: { id: true, title: true, durationSec: true, qaScore: true, qaIssues: true, clientId: true },
    }),
    prisma.clip.findMany({
      where: { status: { in: ["APPROVED", "SCHEDULED", "PUBLISHED"] }, deliveries: { none: { status: "DELIVERED" } } },
      select: { id: true, title: true, clientId: true },
    }),
    prisma.publication.count({ where: { status: "FAILED" } }),
  ]);

  const byClient = new Map(clients.map((c) => [c.id, c]));

  const toEdit = rushes
    .map((r) => {
      const client = r.clientId ? byClient.get(r.clientId) : null;
      const prio = client
        ? productionPriority({
            score: client.score,
            clipsPerMonth: client.clipsPerMonth,
            clipsDelivered: client.clipsDelivered,
            mrrCents: client.mrrCents,
            nextDueAt: r.dueAt,
            status: client.status,
          })
        : { priority: 10, reason: "Rush sans client rattaché." };
      return {
        rushId: r.id,
        title: r.title,
        client: r.client?.name ?? null,
        clientId: r.clientId,
        durationSec: r.durationSec,
        moments: r._count.moments,
        existingPlans: r._count.editPlans,
        clips: r._count.clips,
        clipsTarget: r.clipsTarget,
        dueAt: r.dueAt,
        clipLengthRange: r.client ? [r.client.minClipSeconds, r.client.maxClipSeconds] : [18, 60],
        priority: prio.priority,
        why: prio.reason,
      };
    })
    .sort((a, b) => b.priority - a.priority);

  const delivery = await checkDeliveryTarget();

  return json({
    ok: true,
    summary: {
      rushesToEdit: toEdit.filter((r) => r.existingPlans === 0).length,
      plansToRender: pendingPlans.filter((p) => p.status === "DRAFT").length,
      plansFailed: pendingPlans.filter((p) => p.status === "FAILED").length,
      clipsToReview: clipsToReview.length,
      clipsNotDelivered: approvedNotDelivered.length,
      publicationsFailed: failedPubs,
    },
    delivery: { configured: Boolean(config.delivery.dir), auto: config.delivery.auto, ...delivery },
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      quota: `${c.clipsDelivered}/${c.clipsPerMonth}`,
      remaining: Math.max(0, c.clipsPerMonth - c.clipsDelivered),
      nextDueAt: c.rushes[0]?.dueAt ?? null,
      brief: c.brief,
      hookGuidelines: c.hookGuidelines,
      avoid: c.avoid,
      networks: c.targetNetworks,
      clipLengthRange: [c.minClipSeconds, c.maxClipSeconds],
    })),
    rushesToEdit: toEdit,
    plansPending: pendingPlans,
    clipsToReview,
    clipsNotDelivered: approvedNotDelivered,
  });
}
