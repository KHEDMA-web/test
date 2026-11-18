/**
 * Dépose un lien et en fait un rush : VOD, rediffusion, direct en cours.
 * `prepare: true` enchaîne transcription et détection des moments.
 */
import { z } from "zod";
import { ingestFromLink, transcribeRush, detectRushMoments } from "@/lib/pipeline/ingest";
import { buildEditBrief } from "@/lib/pipeline/brief";
import { json, fail, authorize } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  url: z.string().url(),
  clientId: z.string().optional().nullable(),
  title: z.string().max(200).optional(),
  startSec: z.number().min(0).optional(),
  endSec: z.number().min(0).optional(),
  recordSeconds: z.number().int().min(30).max(14_400).optional(),
  maxHeight: z.number().int().min(360).max(2160).optional(),
  clipsTarget: z.number().int().min(1).max(20).optional(),
  prepare: z.boolean().optional(),
});

export async function POST(req: Request) {
  const denied = authorize(req);
  if (denied) return denied;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("Corps invalide : `url` est requis.", 400);
  const { prepare, ...input } = parsed.data;

  try {
    const { rush, info } = await ingestFromLink(input);

    if (!prepare) {
      return json({ ok: true, rush: { id: rush.id, title: rush.title, durationSec: rush.durationSec }, info });
    }

    const tr = await transcribeRush(rush.id);
    const det = await detectRushMoments(rush.id);
    const brief = await buildEditBrief(rush.id);

    return json({
      ok: true,
      rush: { id: rush.id, title: rush.title, durationSec: rush.durationSec },
      info,
      transcription: tr,
      detection: { moments: det.moments, hooks: det.hooks },
      brief: { chars: brief.approxChars, transcriptMode: brief.transcriptMode, note: brief.transcriptNote },
    });
  } catch (err) {
    return fail((err as Error).message, 422);
  }
}
