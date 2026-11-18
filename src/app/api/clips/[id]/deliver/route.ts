/** Dépose le clip dans le dossier synchronisé (Drive). */
import { deliverClip, DeliveryError, checkDeliveryTarget } from "@/lib/delivery/drive";
import { json, fail, authorize } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { dir?: string; overwrite?: boolean };

  try {
    const result = await deliverClip(id, body);
    return json({ ok: true, delivery: result });
  } catch (err) {
    if (err instanceof DeliveryError) {
      const target = await checkDeliveryTarget(body.dir);
      return fail(err.message, 409, { hint: err.hint, target });
    }
    return fail((err as Error).message, 500);
  }
}
