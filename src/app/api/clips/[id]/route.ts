/** Fiche d'un clip : son montage, sa QA, sa livraison, ses publications. */
import { prisma } from "@/lib/db";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const clip = await prisma.clip.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, name: true, targetNetworks: true } },
      rush: { select: { id: true, title: true, durationSec: true } },
      editPlan: true,
      deliveries: { orderBy: { createdAt: "desc" } },
      publications: { orderBy: { scheduledAt: "asc" } },
      reviews: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!clip) return fail("Clip introuvable.", 404);

  return json({
    ok: true,
    clip: {
      id: clip.id,
      title: clip.title,
      status: clip.status,
      caption: clip.caption,
      hashtags: clip.hashtags,
      durationSec: clip.durationSec,
      width: clip.width,
      height: clip.height,
      sizeBytes: clip.sizeBytes,
      qaScore: clip.qaScore,
      qaIssues: clip.qaIssues,
      cuts: clip.cutsSummary,
      renderRecipe: clip.renderRecipe,
      views: clip.views,
      localPath: clip.filePath,
    },
    client: clip.client,
    rush: clip.rush,
    plan: clip.editPlan
      ? {
          id: clip.editPlan.id,
          hook: clip.editPlan.hook,
          rationale: clip.editPlan.rationale,
          author: clip.editPlan.author,
          source: clip.editPlan.source,
          warnings: clip.editPlan.warnings,
        }
      : null,
    deliveries: clip.deliveries,
    publications: clip.publications,
    reviews: clip.reviews,
  });
}
