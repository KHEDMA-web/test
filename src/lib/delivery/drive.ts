/**
 * Livraison : déposer le clip fini dans un dossier synchronisé.
 *
 * Le dossier est typiquement un Drive (ou Dropbox, ou iCloud) monté sur la
 * machine : dès que le fichier y est écrit, le client de synchronisation
 * l'envoie en ligne. La plateforme n'a donc aucune API de stockage à
 * connaître — elle écrit un fichier, c'est tout.
 *
 * À côté de la vidéo, on dépose une fiche lisible (.txt) avec la légende,
 * les hashtags et les réseaux visés, et une fiche complète (.json) pour
 * tout outil qui voudrait automatiser la suite.
 */
import { copyFile, mkdir, stat, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { prisma } from "../db";
import { logEvent } from "../log";
import { config } from "../config";
import { slugify, formatTimecode } from "../utils";

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/** Vérifie que le dossier de livraison existe et est accessible en écriture. */
export async function checkDeliveryTarget(dir = config.delivery.dir): Promise<{
  ok: boolean;
  dir: string;
  message: string;
}> {
  if (!dir) {
    return {
      ok: false,
      dir: "",
      message: "CLIPFLOW_DELIVERY_DIR n'est pas renseigné : aucun dossier de livraison configuré.",
    };
  }
  const resolved = path.resolve(dir);
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      return { ok: false, dir: resolved, message: `${resolved} existe mais n'est pas un dossier.` };
    }
  } catch {
    return {
      ok: false,
      dir: resolved,
      message: `Dossier introuvable : ${resolved}. Si c'est un Drive, vérifiez qu'il est bien monté et synchronisé.`,
    };
  }
  try {
    await access(resolved, constants.W_OK);
  } catch {
    return { ok: false, dir: resolved, message: `Pas de droit d'écriture sur ${resolved}.` };
  }
  return { ok: true, dir: resolved, message: `Dossier prêt : ${resolved}` };
}

type Cut = { start: number; end: number; note?: string; zoom?: number };

function buildSidecar(args: {
  clipTitle: string;
  clientName: string | null;
  caption: string | null;
  hashtags: string[];
  hook: string | null;
  durationSec: number | null;
  networks: string[];
  scheduledFor: string | null;
  cuts: Cut[];
  rationale: string | null;
  rushTitle: string;
}): string {
  const lines: string[] = [];
  lines.push(args.clipTitle);
  lines.push("=".repeat(Math.min(72, args.clipTitle.length)));
  lines.push("");
  if (args.clientName) lines.push(`Client      : ${args.clientName}`);
  lines.push(`Rush        : ${args.rushTitle}`);
  if (args.durationSec) lines.push(`Durée       : ${args.durationSec.toFixed(1)} s`);
  if (args.networks.length) lines.push(`Réseaux     : ${args.networks.join(", ")}`);
  if (args.scheduledFor) lines.push(`Publication : ${args.scheduledFor}`);
  lines.push("");
  if (args.hook) {
    lines.push("HOOK À L'ÉCRAN");
    lines.push(args.hook);
    lines.push("");
  }
  lines.push("LÉGENDE");
  lines.push(args.caption ?? "—");
  if (args.hashtags.length) {
    lines.push("");
    lines.push(args.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" "));
  }
  if (args.cuts.length) {
    lines.push("");
    lines.push("MONTAGE");
    args.cuts.forEach((c, i) => {
      lines.push(
        `  ${i + 1}. ${formatTimecode(c.start)} → ${formatTimecode(c.end)} (${(c.end - c.start).toFixed(1)} s)${c.note ? ` — ${c.note}` : ""}`,
      );
    });
  }
  if (args.rationale) {
    lines.push("");
    lines.push("INTENTION");
    lines.push(args.rationale);
  }
  lines.push("");
  lines.push(`Déposé par ClipFlow le ${new Date().toLocaleString("fr-FR")}`);
  return lines.join("\n") + "\n";
}

/** Ajoute un suffixe si le nom est déjà pris, pour ne jamais écraser une livraison. */
async function uniquePath(target: string): Promise<string> {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let i = 0; i < 100; i += 1) {
    const candidate = i === 0 ? target : path.join(dir, `${base}-${i + 1}${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

export type DeliverResult = {
  deliveryId: string;
  absolutePath: string;
  relativePath: string;
  sidecarPath: string | null;
  thumbPath: string | null;
  sizeBytes: number;
  publicUrl: string | null;
};

/**
 * Dépose un clip dans le dossier de livraison.
 * Rangement : <racine>/<client>/<AAAA-MM-JJ>/<titre>.mp4
 */
export async function deliverClip(
  clipId: string,
  opts: { dir?: string; overwrite?: boolean } = {},
): Promise<DeliverResult> {
  const clip = await prisma.clip.findUniqueOrThrow({
    where: { id: clipId },
    include: {
      client: true,
      rush: true,
      editPlan: true,
      publications: { orderBy: { scheduledAt: "asc" } },
    },
  });

  if (!clip.filePath) {
    throw new DeliveryError("Ce clip n'a pas de fichier rendu.", "Lancez le rendu du plan de montage d'abord.");
  }

  const target = await checkDeliveryTarget(opts.dir ?? config.delivery.dir);
  if (!target.ok) {
    throw new DeliveryError(target.message, "Réglages → dossier de livraison.");
  }

  const clientFolder = slugify(clip.client?.name ?? "sans-client") || "sans-client";
  const dayFolder = new Date().toISOString().slice(0, 10);
  const destDir = path.join(target.dir, clientFolder, dayFolder);
  await mkdir(destDir, { recursive: true });

  const baseName = slugify(clip.title) || `clip-${clip.id.slice(0, 8)}`;
  const videoTarget = opts.overwrite
    ? path.join(destDir, `${baseName}.mp4`)
    : await uniquePath(path.join(destDir, `${baseName}.mp4`));

  const delivery = await prisma.delivery.create({
    data: {
      clipId: clip.id,
      clientId: clip.clientId,
      rootDir: target.dir,
      filePath: path.relative(target.dir, videoTarget),
      status: "PENDING",
    },
  });

  try {
    await copyFile(clip.filePath, videoTarget);

    // La vignette, si elle existe : pratique pour repérer le clip dans Drive.
    let thumbTarget: string | null = null;
    if (clip.previewPath) {
      thumbTarget = videoTarget.replace(/\.mp4$/, ".jpg");
      await copyFile(clip.previewPath, thumbTarget).catch(() => {
        thumbTarget = null;
      });
    }

    const cuts = (clip.cutsSummary as unknown as Cut[]) ?? [];
    const networks = [...new Set(clip.publications.map((p) => p.network))];
    const nextPub = clip.publications[0];

    const sidecarTarget = videoTarget.replace(/\.mp4$/, ".txt");
    await writeFile(
      sidecarTarget,
      buildSidecar({
        clipTitle: clip.title,
        clientName: clip.client?.name ?? null,
        caption: clip.caption,
        hashtags: clip.hashtags,
        hook: clip.editPlan?.hook ?? null,
        durationSec: clip.durationSec,
        networks: networks.length ? networks : (clip.client?.targetNetworks ?? []),
        scheduledFor: nextPub ? `${nextPub.scheduledAtLocal} (${nextPub.timezone})` : null,
        cuts,
        rationale: clip.editPlan?.rationale ?? null,
        rushTitle: clip.rush.title,
      }),
      "utf8",
    );

    // Fiche complète, pour un outil qui automatiserait la suite.
    await writeFile(
      videoTarget.replace(/\.mp4$/, ".json"),
      JSON.stringify(
        {
          clipId: clip.id,
          title: clip.title,
          client: clip.client?.name ?? null,
          rush: clip.rush.title,
          hook: clip.editPlan?.hook ?? null,
          caption: clip.caption,
          hashtags: clip.hashtags,
          durationSec: clip.durationSec,
          width: clip.width,
          height: clip.height,
          cuts,
          networks,
          scheduledAt: nextPub?.scheduledAt ?? null,
          deliveredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );

    const info = await stat(videoTarget);
    const relative = path.relative(target.dir, videoTarget).split(path.sep).join("/");
    const publicUrl = config.delivery.publicBase
      ? `${config.delivery.publicBase.replace(/\/$/, "")}/${relative}`
      : null;

    const saved = await prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status: "DELIVERED",
        filePath: relative,
        sidecarPath: path.relative(target.dir, sidecarTarget).split(path.sep).join("/"),
        thumbPath: thumbTarget ? path.relative(target.dir, thumbTarget).split(path.sep).join("/") : null,
        sizeBytes: BigInt(info.size),
        publicUrl,
        deliveredAt: new Date(),
        error: null,
      },
    });

    await logEvent({
      stage: "deliver",
      entity: `clip:${clip.id}`,
      message: `Livré dans le dossier synchronisé : ${relative} (${(info.size / 1e6).toFixed(1)} Mo)`,
      data: { root: target.dir, publicUrl },
    });

    return {
      deliveryId: saved.id,
      absolutePath: videoTarget,
      relativePath: relative,
      sidecarPath: saved.sidecarPath,
      thumbPath: saved.thumbPath,
      sizeBytes: info.size,
      publicUrl,
    };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: "FAILED", error: message },
    });
    await logEvent({
      stage: "deliver",
      entity: `clip:${clip.id}`,
      level: "error",
      message: `Livraison échouée : ${message}`,
    });
    throw new DeliveryError(`Livraison échouée : ${message}`);
  }
}
