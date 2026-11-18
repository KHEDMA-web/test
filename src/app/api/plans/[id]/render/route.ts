/** Rendu d'un plan de montage déjà enregistré. */
import { renderPlan } from "@/lib/pipeline/clips";
import { prisma } from "@/lib/db";
import { json, fail, authorize } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  const plan = await prisma.editPlan.findUnique({ where: { id } });
  if (!plan) return fail("Plan introuvable.", 404);

  try {
    const clip = await renderPlan(id);
    return json({
      ok: true,
      clip: {
        id: clip.id,
        title: clip.title,
        status: clip.status,
        durationSec: clip.durationSec,
        qaScore: clip.qaScore,
        qaIssues: clip.qaIssues,
        cuts: clip.cutsSummary,
      },
    });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
