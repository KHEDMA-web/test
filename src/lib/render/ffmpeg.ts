/**
 * Rendu vidéo — FFmpeg en child_process.
 *
 * Produit le brouillon automatique d'un clip : découpe du moment, passage en
 * 9:16, sous-titres incrustés, hook en overlay, audio normalisé pour les
 * réseaux. C'est la moitié « auto » du montage hybride ; le clipper peut
 * ensuite déposer sa propre version, qui prend le relais.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildAss } from "./ass";
import type { Segment } from "../transcription/types";

const exec = promisify(execFile);

export type MediaProbe = {
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  sizeBytes: number | null;
  mimeType: string | null;
};

type FfprobeStream = {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string;
};

/** Lit les caractéristiques d'un fichier ou d'une URL. */
export async function probeMedia(source: string): Promise<MediaProbe> {
  const { stdout } = await exec(
    "ffprobe",
    [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      source,
    ],
    { maxBuffer: 1024 * 1024 * 8 },
  );

  const json = JSON.parse(stdout) as {
    streams?: FfprobeStream[];
    format?: { duration?: string; size?: string; format_name?: string };
  };

  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");

  let fps: number | null = null;
  if (video?.r_frame_rate && video.r_frame_rate.includes("/")) {
    const [num, den] = video.r_frame_rate.split("/").map(Number);
    if (den > 0) fps = Number((num / den).toFixed(3));
  }

  let sizeBytes: number | null = json.format?.size ? Number(json.format.size) : null;
  if (sizeBytes === null && !/^https?:\/\//.test(source)) {
    try {
      sizeBytes = (await stat(source)).size;
    } catch {
      sizeBytes = null;
    }
  }

  return {
    durationSec: Number(json.format?.duration ?? video?.duration ?? 0),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps,
    hasAudio: Boolean(audio),
    sizeBytes,
    mimeType: json.format?.format_name ? `video/${json.format.format_name.split(",")[0]}` : null,
  };
}

/** Cadrage vertical : recadrage centré, ou fond flou pour garder le plan large. */
export type FramingMode = "cover" | "fit-blur" | "fit-bars";

export type RenderRecipe = {
  startSec: number;
  endSec: number;
  hook?: string | null;
  framing?: FramingMode;
  width?: number;
  height?: number;
  burnSubtitles?: boolean;
  /** Normalisation du volume pour les réseaux (EBU R128, cible -14 LUFS). */
  normalizeAudio?: boolean;
  fps?: number;
  crf?: number;
  /** Le rush a-t-il une piste audio ? Sans audio, on n'applique ni loudnorm ni mapping. */
  hasAudio?: boolean;
};

export type RenderResult = {
  outputPath: string;
  thumbnailPath: string | null;
  durationSec: number;
  sizeBytes: number;
  command: string;
  recipe: Required<Omit<RenderRecipe, "hook">> & { hook: string | null };
  log: string;
};

function videoFilter(mode: FramingMode, w: number, h: number): string {
  switch (mode) {
    case "fit-blur":
      // Le plan entier reste visible, les bandes sont remplies par un flou de lui-même.
      return [
        `[0:v]split=2[bg][fg]`,
        `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=28,eq=brightness=-0.12[bgb]`,
        `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgs]`,
        `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`,
      ].join(";");
    case "fit-bars":
      return `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
    case "cover":
    default:
      return `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  }
}

/** Échappe un chemin pour l'option `filename` du filtre `subtitles`. */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}

/**
 * Rend un clip vertical à partir d'un rush.
 * `segments` sert aux sous-titres : leurs temps sont absolus dans le rush.
 */
export async function renderClip(args: {
  source: string;
  outputPath: string;
  recipe: RenderRecipe;
  segments?: Segment[];
  thumbnail?: boolean;
}): Promise<RenderResult> {
  const w = args.recipe.width ?? 1080;
  const h = args.recipe.height ?? 1920;
  const fps = args.recipe.fps ?? 30;
  const crf = args.recipe.crf ?? 20;
  const framing = args.recipe.framing ?? "cover";
  const burn = args.recipe.burnSubtitles ?? true;
  const normalize = args.recipe.normalizeAudio ?? true;
  const duration = Math.max(0.5, args.recipe.endSec - args.recipe.startSec);

  await mkdir(path.dirname(args.outputPath), { recursive: true });
  const workDir = await import("node:fs/promises").then((fs) =>
    fs.mkdtemp(path.join(os.tmpdir(), "clipflow-render-")),
  );

  try {
    const filters = [videoFilter(framing, w, h)];

    // Sous-titres et hook : un seul fichier ASS, un seul filtre.
    const needsAss = burn || Boolean(args.recipe.hook);
    if (needsAss) {
      const ass = buildAss({
        segments: burn ? (args.segments ?? []) : [],
        clipStartSec: args.recipe.startSec,
        clipEndSec: args.recipe.endSec,
        hook: args.recipe.hook ?? null,
        style: { width: w, height: h },
      });
      const assPath = path.join(workDir, "subs.ass");
      await writeFile(assPath, ass, "utf8");
      filters.push(
        `ass=filename='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath("/usr/share/fonts")}'`,
      );
    }

    filters.push(`fps=${fps}`, "format=yuv420p");

    // Chaînage du graphe : le premier maillon consomme [0:v], le dernier
    // est étiqueté [vout] pour être mappé explicitement.
    const filterComplex =
      filters.reduce((acc, f, i) => (i === 0 ? f : `${acc}[v${i - 1}];[v${i - 1}]${f}`), "") +
      "[vout]";

    const hasAudio = args.recipe.hasAudio ?? true;

    const ffArgs = [
      "-hide_banner",
      "-y",
      // Recherche avant -i : rapide, et suffisamment précise puisqu'on réencode.
      "-ss", args.recipe.startSec.toFixed(3),
      "-t", duration.toFixed(3),
      "-i", args.source,
      "-filter_complex", filterComplex,
      "-map", "[vout]",
      // `?` : un rush muet ne fait pas échouer le rendu.
      ...(hasAudio ? ["-map", "0:a?"] : ["-an"]),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", String(crf),
      "-profile:v", "high",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      ...(hasAudio
        ? [
            "-c:a", "aac",
            "-b:a", "128k",
            "-ar", "48000",
            // Cible -14 LUFS : le niveau attendu par les plateformes sociales.
            ...(normalize ? ["-af", "loudnorm=I=-14:TP=-1.5:LRA=11"] : []),
          ]
        : []),
      "-shortest",
      args.outputPath,
    ];

    const { stderr } = await exec("ffmpeg", ffArgs, {
      maxBuffer: 1024 * 1024 * 32,
      timeout: 1000 * 60 * 20,
    });

    let thumbnailPath: string | null = null;
    if (args.thumbnail !== false) {
      thumbnailPath = args.outputPath.replace(/\.\w+$/, "") + ".jpg";
      await exec("ffmpeg", [
        "-hide_banner", "-y",
        "-ss", Math.min(1.2, duration / 2).toFixed(2),
        "-i", args.outputPath,
        "-frames:v", "1",
        "-q:v", "3",
        thumbnailPath,
      ], { maxBuffer: 1024 * 1024 * 8 });
    }

    const out = await stat(args.outputPath);

    return {
      outputPath: args.outputPath,
      thumbnailPath,
      durationSec: duration,
      sizeBytes: out.size,
      command: ["ffmpeg", ...ffArgs].join(" "),
      recipe: {
        startSec: args.recipe.startSec,
        endSec: args.recipe.endSec,
        hook: args.recipe.hook ?? null,
        framing,
        width: w,
        height: h,
        burnSubtitles: burn,
        normalizeAudio: normalize,
        fps,
        crf,
        hasAudio,
      },
      log: stderr.slice(-4000),
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** Petit rush de test, pour vérifier le pipeline sans fichier source. */
export async function generateTestRush(outputPath: string, durationSec = 180): Promise<MediaProbe> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await exec(
    "ffmpeg",
    [
      "-hide_banner", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${durationSec}`,
      "-f", "lavfi", "-i", `sine=frequency=220:duration=${durationSec}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "64k",
      "-shortest",
      outputPath,
    ],
    { maxBuffer: 1024 * 1024 * 16, timeout: 1000 * 60 * 10 },
  );
  return probeMedia(outputPath);
}
