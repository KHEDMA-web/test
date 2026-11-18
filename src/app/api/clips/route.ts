/** Liste des clips, filtrable par statut ou par client. */
import { prisma } from "@/lib/db";
import { json } from "@/lib/api";
import type { ClipStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const clientId = url.searchParams.get("clientId");
  const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 25));

  const clips = await prisma.clip.findMany({
    where: {
      ...(status ? { status: status as ClipStatus } : {}),
      ...(clientId ? { clientId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      client: { select: { name: true } },
      rush: { select: { id: true, title: true } },
      editPlan: { select: { id: true, hook: true, author: true } },
      deliveries: { where: { status: "DELIVERED" }, select: { filePath: true, deliveredAt: true } },
      publications: { select: { network: true, status: true, scheduledAtLocal: true } },
    },
  });

  return json({
    ok: true,
    count: clips.length,
    clips: clips.map((c) => ({
      id: c.id,
      title: c.title,
      status: c.status,
      durationSec: c.durationSec,
      qaScore: c.qaScore,
      qaIssues: c.qaIssues,
      client: c.client?.name ?? null,
      rush: c.rush,
      hook: c.editPlan?.hook ?? null,
      author: c.editPlan?.author ?? null,
      cuts: c.cutsSummary,
      delivered: c.deliveries[0] ?? null,
      publications: c.publications,
      views: c.views,
    })),
  });
}
