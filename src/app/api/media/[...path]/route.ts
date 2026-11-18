/**
 * Sert les rushes et les clips depuis le dossier de stockage.
 * Gère les requêtes partielles (Range), indispensables pour qu'un
 * navigateur puisse lire une vidéo sans la télécharger entièrement.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { resolveWithinStorage } from "@/lib/storage";
import type { ReadableOptions } from "node:stream";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
};

function toWebStream(filePath: string, opts?: ReadableOptions & { start?: number; end?: number }) {
  const nodeStream = createReadStream(filePath, opts);
  return new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk as Buffer)));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path: parts } = await ctx.params;
  // `resolveWithinStorage` bloque toute tentative de sortie du dossier.
  const target = resolveWithinStorage(parts.join("/"));
  if (!target) return NextResponse.json({ error: "Chemin invalide." }, { status: 400 });

  let info;
  try {
    info = await stat(target);
  } catch {
    return NextResponse.json({ error: "Fichier introuvable." }, { status: 404 });
  }
  if (!info.isFile()) return NextResponse.json({ error: "Chemin invalide." }, { status: 400 });

  const type = MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : info.size - 1;
    if (start >= info.size || end >= info.size || start > end) {
      return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    }
    return new NextResponse(toWebStream(target, { start, end }), {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  return new NextResponse(toWebStream(target), {
    headers: {
      "Content-Type": type,
      "Content-Length": String(info.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
    },
  });
}
