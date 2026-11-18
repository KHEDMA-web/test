/**
 * Transcription d'un rush, éventuellement fenêtrée.
 * Sur un rush long, le brief complet est trop gros : on lit par tranches.
 */
import { prisma } from "@/lib/db";
import { json, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const from = Number(url.searchParams.get("from") ?? 0);
  const to = Number(url.searchParams.get("to") ?? Number.MAX_SAFE_INTEGER);
  const withWords = url.searchParams.get("words") === "1";

  const rush = await prisma.rush.findUnique({
    where: { id },
    select: { id: true, title: true, durationSec: true, language: true },
  });
  if (!rush) return fail("Rush introuvable.", 404);

  const segments = await prisma.transcriptSegment.findMany({
    where: { rushId: id, endSec: { gt: from }, startSec: { lt: to } },
    orderBy: { idx: "asc" },
    select: {
      idx: true,
      startSec: true,
      endSec: true,
      text: true,
      speaker: true,
      ...(withWords ? { words: true } : {}),
    },
  });

  return json({
    ok: true,
    rush,
    window: { from, to: Number.isFinite(to) ? to : rush.durationSec },
    count: segments.length,
    segments,
  });
}
