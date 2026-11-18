/**
 * Résolution des sources : n'importe quel lien devient un rush.
 *
 * VOD YouTube, rediffusion Twitch, direct en cours, Vimeo, ou simple
 * fichier déposé quelque part — yt-dlp couvre près de deux mille sites.
 * La plateforme n'a donc pas une intégration par plateforme à maintenir.
 *
 * Trois cas, trois comportements :
 *   - vidéo publiée   → téléchargement, éventuellement d'une seule tranche
 *   - direct en cours → on ne peut pas remonter le temps : on enregistre
 *                       une fenêtre à partir de maintenant
 *   - fichier direct  → rien à résoudre, ffprobe suffit
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { storagePath, ensureStorage, safeFileName } from "../storage";
import { logEvent } from "../log";

const exec = promisify(execFile);
const SCRIPT = path.join(process.cwd(), "scripts", "resolve_source.py");

export type SourceInfo = {
  ok: boolean;
  kind?: "video" | "live" | "playlist";
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  durationSec?: number | null;
  isLive?: boolean;
  wasLive?: boolean;
  extractor?: string;
  webpageUrl?: string;
  thumbnail?: string;
  width?: number;
  height?: number;
  fps?: number;
  language?: string;
  uploadDate?: string;
  error?: string;
  entryCount?: number;
  entries?: Array<{ title?: string; url?: string; durationSec?: number }>;
};

/** Un lien qui pointe directement sur un fichier n'a pas besoin de yt-dlp. */
export function looksLikeDirectMedia(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return /\.(mp4|mov|m4v|webm|mkv|mp3|m4a|wav|aac|flac)$/i.test(pathname);
  } catch {
    return false;
  }
}

async function runResolver(args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const python = process.env.CLIPFLOW_PYTHON ?? "python3";
  try {
    const { stdout } = await exec(python, [SCRIPT, ...args], {
      maxBuffer: 1024 * 1024 * 32,
      timeout: timeoutMs,
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string };
    // Le script écrit son erreur en JSON sur la sortie standard même en échec.
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout) as Record<string, unknown>;
      } catch {
        /* on continue sur le message brut */
      }
    }
    if (e.code === "ENOENT") {
      return { ok: false, error: "python3 est introuvable : impossible de résoudre les liens." };
    }
    return { ok: false, error: `Résolution du lien échouée : ${(err as Error).message.slice(0, 300)}` };
  }
}

/** Métadonnées d'un lien, sans rien télécharger. */
export async function probeSource(url: string): Promise<SourceInfo> {
  return (await runResolver(["--mode", "probe", "--url", url], 1000 * 180)) as SourceInfo;
}

export type FetchOptions = {
  /** Ne prendre qu'une tranche de la vidéo, en secondes. */
  startSec?: number;
  endSec?: number;
  /** Hauteur maximale récupérée. 1080 suffit pour un 9:16. */
  maxHeight?: number;
  /** Durée de capture quand la source est un direct. */
  recordSeconds?: number;
  fileName?: string;
};

export type FetchResult = {
  ok: boolean;
  filePath?: string;
  sizeBytes?: number;
  info?: SourceInfo;
  recordedSeconds?: number;
  error?: string;
};

/**
 * Récupère la source en local. Choisit seul entre téléchargement et
 * capture d'un direct, d'après ce que le probe a trouvé.
 */
export async function fetchSource(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  await ensureStorage();

  const info = await probeSource(url);
  if (!info.ok) return { ok: false, error: info.error ?? "lien non résolu", info };

  const base = safeFileName(`${info.id ?? Date.now()}-${info.title ?? "source"}`).slice(0, 80);
  const target = storagePath("rush", `${opts.fileName ?? base}.mp4`);
  const maxHeight = opts.maxHeight ?? 1080;

  if (info.isLive) {
    const seconds = opts.recordSeconds ?? 600;
    await logEvent({
      stage: "ingest",
      entity: `source:${info.id ?? url}`,
      message: `Direct en cours : capture de ${Math.round(seconds / 60)} min à partir de maintenant`,
      data: { title: info.title, extractor: info.extractor },
    });

    const res = await runResolver(
      ["--mode", "record", "--url", url, "--out", target, "--seconds", String(seconds), "--max-height", String(maxHeight)],
      (seconds + 600) * 1000,
    );
    if (!res.ok) return { ok: false, error: String(res.error ?? "capture échouée"), info };
    return {
      ok: true,
      filePath: String(res.path),
      sizeBytes: Number(res.sizeBytes ?? 0),
      recordedSeconds: Number(res.recordedSeconds ?? seconds),
      info,
    };
  }

  const args = ["--mode", "download", "--url", url, "--out", target, "--max-height", String(maxHeight)];
  if (opts.startSec !== undefined && opts.endSec !== undefined && opts.endSec > opts.startSec) {
    args.push("--start", String(opts.startSec), "--end", String(opts.endSec));
  }

  const res = await runResolver(args, 1000 * 60 * 90);
  if (!res.ok) return { ok: false, error: String(res.error ?? "téléchargement échoué"), info };

  await logEvent({
    stage: "ingest",
    entity: `source:${info.id ?? url}`,
    message: `Source récupérée : « ${info.title ?? url} » (${info.extractor ?? "lien direct"})`,
    data: { durationSec: info.durationSec, section: opts.startSec !== undefined ? [opts.startSec, opts.endSec] : null },
  });

  return { ok: true, filePath: String(res.path), sizeBytes: Number(res.sizeBytes ?? 0), info };
}

/** Phrase lisible décrivant ce qu'un lien contient. */
export function describeSource(info: SourceInfo): string {
  if (!info.ok) return info.error ?? "lien non résolu";
  if (info.kind === "playlist") return `playlist de ${info.entryCount ?? "?"} vidéos`;
  const parts: string[] = [];
  if (info.extractor) parts.push(info.extractor);
  if (info.isLive) parts.push("direct en cours");
  else if (info.durationSec) parts.push(`${Math.round(info.durationSec / 60)} min`);
  if (info.height) parts.push(`${info.width}×${info.height}`);
  if (info.uploader) parts.push(info.uploader);
  return parts.join(" · ");
}
