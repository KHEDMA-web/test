/**
 * Lancement du pipeline complet par API : utile pour brancher un dépôt de
 * rushes (webhook d'un stockage, automatisation externe) sans passer par l'UI.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { runFullPipeline } from "@/lib/pipeline/orchestrator";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  campaignId: z.string().optional().nullable(),
  filePath: z.string().optional().nullable(),
  sourceUrl: z.string().url().optional().nullable(),
  language: z.string().optional(),
  options: z
    .object({
      draftCount: z.number().int().min(0).max(12).optional(),
      assign: z.boolean().optional(),
      autoApprove: z.boolean().optional(),
      publish: z.boolean().optional(),
      networks: z.array(z.string()).optional(),
      flushQueue: z.boolean().optional(),
    })
    .optional(),
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Corps invalide", details: parsed.error.flatten() }, { status: 400 });
  }
  const { options, ...input } = parsed.data;
  if (!input.filePath && !input.sourceUrl) {
    return NextResponse.json({ error: "filePath ou sourceUrl est requis." }, { status: 400 });
  }

  try {
    const report = await runFullPipeline(input, {
      ...options,
      networks: options?.networks as never,
    });
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
