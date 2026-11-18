/** Ce qu'il y a derrière un lien, sans rien télécharger. */
import { z } from "zod";
import { probeSource, describeSource } from "@/lib/ingest/source";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

const schema = z.object({ url: z.string().url() });

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Corps invalide : `url` est requis.", 400);

  const info = await probeSource(parsed.data.url);
  if (!info.ok) return fail(info.error ?? "Lien non résolu.", 422, { info });
  return json({ ok: true, info, summary: describeSource(info) });
}
