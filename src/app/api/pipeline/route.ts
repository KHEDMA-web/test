/**
 * Préparation d'un rush par API : ingestion, transcription, détection,
 * jusqu'au brief. Le montage reste une décision prise avec Claude.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prepareRush } from "@/lib/pipeline/orchestrator";
import { buildEditBrief } from "@/lib/pipeline/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  clientId: z.string().optional().nullable(),
  filePath: z.string().optional().nullable(),
  sourceUrl: z.string().url().optional().nullable(),
  language: z.string().optional(),
  origin: z.enum(["CLIENT_UPLOAD", "SOURCED"]).optional(),
  autoDraft: z.number().int().min(0).max(8).optional(),
  /** Renvoyer le brief directement dans la réponse. */
  includeBrief: z.boolean().optional(),
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Corps invalide", details: parsed.error.flatten() }, { status: 400 });
  }
  const { autoDraft, includeBrief, ...input } = parsed.data;
  if (!input.filePath && !input.sourceUrl) {
    return NextResponse.json({ error: "filePath ou sourceUrl est requis." }, { status: 400 });
  }

  try {
    const report = await prepareRush(input, { autoDraft });
    const brief = includeBrief ? (await buildEditBrief(report.rushId)).markdown : undefined;
    return NextResponse.json({ ok: true, report, brief });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
