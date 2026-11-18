/**
 * Le brief de montage, en texte.
 *
 * Deux usages :
 *  - l'interface l'affiche et le copie dans le presse-papiers
 *  - Claude Code (ou tout autre outil) le récupère directement :
 *      curl -s localhost:3000/api/rushes/<id>/brief > brief.md
 */
import { NextResponse } from "next/server";
import { buildEditBrief } from "@/lib/pipeline/brief";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const clipCount = Number(url.searchParams.get("clips")) || undefined;
  const transcript = (url.searchParams.get("transcript") as "full" | "around-moments" | "none" | null) ?? undefined;

  try {
    const brief = await buildEditBrief(id, { clipCount, transcript });

    if (url.searchParams.get("format") === "json") {
      return NextResponse.json(brief);
    }
    return new NextResponse(brief.markdown, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 404 });
  }
}
