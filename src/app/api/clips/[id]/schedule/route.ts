/** Met le clip en file de publication Metricool. */
import { z } from "zod";
import { queueClipPublications, processQueue } from "@/lib/metricool/publish";
import type { MetricoolNetwork } from "@/lib/metricool/client";
import { json, fail, authorize } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({
  networks: z.array(z.string()).min(1),
  scheduledAt: z.string().datetime().optional(),
  text: z.string().max(3000).optional(),
  staggerMinutes: z.number().int().min(0).max(240).optional(),
  send: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = authorize(req);
  if (denied) return denied;

  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Corps invalide : `networks` est requis.", 400);

  try {
    const pubs = await queueClipPublications({
      clipId: id,
      networks: parsed.data.networks as MetricoolNetwork[],
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : new Date(Date.now() + 3 * 3600_000),
      text: parsed.data.text,
      staggerMinutes: parsed.data.staggerMinutes,
    });
    const sent = parsed.data.send === false ? null : await processQueue(pubs.length);
    return json({
      ok: true,
      queued: pubs.map((p) => ({ id: p.id, network: p.network, at: p.scheduledAtLocal, tz: p.timezone })),
      sent,
    });
  } catch (err) {
    return fail((err as Error).message, 500);
  }
}
