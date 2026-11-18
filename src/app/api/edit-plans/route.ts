/**
 * Dépôt d'un plan de montage.
 *
 * Permet à Claude Code — ou à n'importe quel script — de pousser un plan
 * sans passer par le collage dans l'interface :
 *
 *   curl -X POST localhost:3000/api/edit-plans \
 *        -H 'content-type: application/json' \
 *        -d '{"rushId":"...","plan":{...},"render":true}'
 *
 * `plan` accepte aussi bien l'objet JSON que le texte brut d'une réponse
 * de chat : le parseur sait extraire le bloc utile.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { createPlansFromInput } from "@/lib/pipeline/editPlan";
import { renderPlan } from "@/lib/pipeline/clips";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({
  rushId: z.string().min(1),
  /** Objet, tableau de clips, ou texte brut contenant le JSON. */
  plan: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]),
  render: z.boolean().optional(),
  author: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Corps invalide", details: parsed.error.flatten() }, { status: 400 });
  }

  const raw = typeof parsed.data.plan === "string" ? parsed.data.plan : JSON.stringify(parsed.data.plan);

  const result = await createPlansFromInput({
    rushId: parsed.data.rushId,
    raw,
    source: "CLAUDE_CODE",
    author: parsed.data.author ?? "Claude Code",
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, issues: result.issues, note: result.note },
      { status: 422 },
    );
  }

  const clips: Array<{ planId: string; clipId?: string; error?: string }> = [];
  if (parsed.data.render) {
    for (const planId of result.created) {
      try {
        const clip = await renderPlan(planId);
        clips.push({ planId, clipId: clip.id });
      } catch (err) {
        clips.push({ planId, error: (err as Error).message });
      }
    }
  }

  const plans = await prisma.editPlan.findMany({
    where: { id: { in: result.created } },
    select: { id: true, title: true, hook: true, status: true, warnings: true, cuts: true },
  });

  return NextResponse.json({ ok: true, plans, clips, issues: result.issues, note: result.note });
}

/** Liste des plans d'un rush, pour reprendre un montage. */
export async function GET(req: Request) {
  const rushId = new URL(req.url).searchParams.get("rushId");
  if (!rushId) return NextResponse.json({ error: "Paramètre `rushId` requis." }, { status: 400 });

  const plans = await prisma.editPlan.findMany({
    where: { rushId },
    orderBy: { createdAt: "desc" },
    include: { clips: { select: { id: true, status: true, durationSec: true, qaScore: true } } },
  });
  return NextResponse.json({ plans });
}
