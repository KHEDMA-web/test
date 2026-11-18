/** Fiche complète d'un rush : moments scorés, hooks, plans déjà posés. */
import { prisma } from "@/lib/db";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const rush = await prisma.rush.findUnique({
    where: { id },
    include: {
      client: true,
      moments: {
        orderBy: { score: "desc" },
        include: { hooks: { orderBy: { score: "desc" }, take: 5 } },
      },
      editPlans: {
        orderBy: { createdAt: "desc" },
        include: { clips: { select: { id: true, status: true, durationSec: true, qaScore: true } } },
      },
      _count: { select: { segments: true } },
    },
  });
  if (!rush) return fail("Rush introuvable.", 404);

  return json({
    ok: true,
    rush: {
      id: rush.id,
      title: rush.title,
      description: rush.description,
      durationSec: rush.durationSec,
      width: rush.width,
      height: rush.height,
      hasAudio: rush.hasAudio,
      origin: rush.origin,
      clipsTarget: rush.clipsTarget,
      dueAt: rush.dueAt,
      status: rush.status,
      transcriptStatus: rush.transcriptStatus,
      segments: rush._count.segments,
    },
    client: rush.client
      ? {
          id: rush.client.id,
          name: rush.client.name,
          brief: rush.client.brief,
          hookGuidelines: rush.client.hookGuidelines,
          brandVoice: rush.client.brandVoice,
          avoid: rush.client.avoid,
          networks: rush.client.targetNetworks,
          clipLengthRange: [rush.client.minClipSeconds, rush.client.maxClipSeconds],
        }
      : null,
    moments: rush.moments.map((m) => ({
      id: m.id,
      startSec: m.startSec,
      endSec: m.endSec,
      score: m.score,
      emotion: m.emotion,
      rationale: m.rationale,
      transcript: m.transcript,
      hooks: m.hooks.map((h) => ({ id: h.id, text: h.text, style: h.style, score: h.score })),
    })),
    plans: rush.editPlans.map((p) => ({
      id: p.id,
      title: p.title,
      hook: p.hook,
      status: p.status,
      source: p.source,
      author: p.author,
      cuts: p.cuts,
      warnings: p.warnings,
      error: p.error,
      clips: p.clips,
    })),
  });
}
