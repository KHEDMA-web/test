/**
 * Validation d'un clip. Une validation déclenche la livraison dans le
 * dossier synchronisé si elle est configurée en automatique.
 */
import { z } from "zod";
import { reviewClip } from "@/lib/pipeline/clips";
import { prisma } from "@/lib/db";
import { json, fail, authorize } from "@/lib/api";

export const dynamic = "force-dynamic";

const schema = z.object({
  decision: z.enum(["APPROVED", "REJECTED", "CHANGES_REQUESTED"]),
  comment: z.string().max(2000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Corps invalide : `decision` est requis.", 400);

  try {
    const clip = await reviewClip({ clipId: id, ...parsed.data });
    const delivery = await prisma.delivery.findFirst({
      where: { clipId: id, status: "DELIVERED" },
      orderBy: { createdAt: "desc" },
    });
    return json({
      ok: true,
      clip: { id: clip.id, status: clip.status },
      delivered: delivery ? { path: delivery.filePath, at: delivery.deliveredAt } : null,
    });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
