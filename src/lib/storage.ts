/**
 * Stockage local des rushes et des clips.
 *
 * Les fichiers vivent hors de `public/` et sont servis par une route
 * applicative (`/api/media/...`), ce qui permet de contrôler l'accès.
 * Metricool exige en revanche une URL publique et non expirante : c'est
 * `CLIPFLOW_PUBLIC_BASE_URL` qui doit pointer vers un domaine accessible
 * depuis l'extérieur en production (ou un bucket S3/R2).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export const STORAGE_ROOT = path.resolve(process.cwd(), config.storageDir);

export type MediaKind = "rush" | "clip" | "thumb";

export function storagePath(kind: MediaKind, ...parts: string[]): string {
  return path.join(STORAGE_ROOT, `${kind}s`, ...parts);
}

export async function ensureStorage(): Promise<void> {
  await Promise.all([
    mkdir(storagePath("rush"), { recursive: true }),
    mkdir(storagePath("clip"), { recursive: true }),
    mkdir(storagePath("thumb"), { recursive: true }),
  ]);
}

/** Chemin disque → URL servie par l'application. */
export function publicUrlFor(absolutePath: string): string {
  const rel = path.relative(STORAGE_ROOT, absolutePath).split(path.sep).join("/");
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/media/${rel}`;
}

/** Garde-fou : empêche de sortir du dossier de stockage via `..`. */
export function resolveWithinStorage(relative: string): string | null {
  const target = path.resolve(STORAGE_ROOT, relative);
  const root = path.resolve(STORAGE_ROOT);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

export function safeFileName(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").slice(0, 120) || "fichier";
}

export async function saveUpload(kind: MediaKind, fileName: string, data: ArrayBuffer | Uint8Array): Promise<string> {
  await ensureStorage();
  const target = storagePath(kind, `${Date.now()}-${safeFileName(fileName)}`);
  await writeFile(target, data instanceof Uint8Array ? data : new Uint8Array(data));
  return target;
}
