/**
 * Enchaînement complet : rush → transcription → moments → hooks →
 * brouillons auto → (attribution) → validation → file Metricool.
 *
 * C'est la vue « un seul bouton » du flux ; chaque étape reste appelable
 * séparément depuis l'UI ou l'API.
 */
import { prisma } from "../db";
import { logEvent } from "../log";
import { ingestRush, transcribeRush, detectRushMoments, type IngestInput } from "./ingest";
import { renderAutoDraft, reviewClip } from "./clips";
import { assignRush } from "./assign";
import { queueClipPublications, processQueue } from "../metricool/publish";
import type { MetricoolNetwork } from "../metricool/client";

export type PipelineOptions = {
  /** Nombre de brouillons auto à rendre (0 = aucun rendu). */
  draftCount?: number;
  /** Attribuer le rush au meilleur clipper disponible. */
  assign?: boolean;
  /** Valider automatiquement les brouillons (démo / campagnes de confiance). */
  autoApprove?: boolean;
  /** Mettre en file les clips validés. */
  publish?: boolean;
  networks?: MetricoolNetwork[];
  firstPublicationAt?: Date;
  /** Traiter la file tout de suite au lieu d'attendre le cron. */
  flushQueue?: boolean;
};

export type PipelineReport = {
  rushId: string;
  steps: Array<{ stage: string; detail: string; ok: boolean }>;
  momentCount: number;
  hookCount: number;
  clipIds: string[];
  publicationIds: string[];
  warnings: string[];
};

export async function runFullPipeline(
  input: IngestInput,
  opts: PipelineOptions = {},
): Promise<PipelineReport> {
  const steps: PipelineReport["steps"] = [];
  const warnings: string[] = [];
  const clipIds: string[] = [];
  const publicationIds: string[] = [];

  const rush = await ingestRush(input);
  steps.push({
    stage: "1 · Ingestion",
    detail: `Rush « ${rush.title} » — ${rush.durationSec?.toFixed(0) ?? "?"} s, ${rush.width}×${rush.height}`,
    ok: true,
  });

  const tr = await transcribeRush(rush.id);
  steps.push({ stage: "2 · Transcription", detail: `${tr.segments} segments via ${tr.provider}`, ok: true });

  const det = await detectRushMoments(rush.id);
  warnings.push(...det.warnings);
  steps.push({
    stage: "3 · Moments & hooks",
    detail: `${det.moments} moments retenus, ${det.hooks} hooks générés`,
    ok: true,
  });

  if (opts.assign) {
    try {
      const { chosen } = await assignRush({ rushId: rush.id });
      steps.push({
        stage: "1b · Attribution",
        detail: `Confié à ${chosen.name} (${chosen.tier}, adéquation ${chosen.match.score}/100)`,
        ok: true,
      });
    } catch (err) {
      warnings.push(`Attribution impossible : ${(err as Error).message}`);
      steps.push({ stage: "1b · Attribution", detail: (err as Error).message, ok: false });
    }
  }

  const draftCount = opts.draftCount ?? 3;
  if (draftCount > 0) {
    const moments = await prisma.moment.findMany({
      where: { rushId: rush.id },
      orderBy: { score: "desc" },
      take: draftCount,
    });
    for (const m of moments) {
      try {
        const clip = await renderAutoDraft(m.id);
        clipIds.push(clip.id);
      } catch (err) {
        warnings.push(`Rendu du moment ${Math.round(m.startSec)}s échoué : ${(err as Error).message}`);
      }
    }
    steps.push({
      stage: "4 · Montage auto",
      detail: `${clipIds.length}/${moments.length} brouillons rendus en 9:16`,
      ok: clipIds.length > 0,
    });
  }

  if (opts.autoApprove && clipIds.length) {
    for (const id of clipIds) {
      await reviewClip({ clipId: id, decision: "APPROVED", comment: "Validation automatique (pipeline)" });
    }
    steps.push({ stage: "4b · Validation", detail: `${clipIds.length} clip(s) validés`, ok: true });
  }

  if (opts.publish && clipIds.length) {
    const networks = opts.networks ?? ["instagram", "tiktok", "youtube"];
    const start = opts.firstPublicationAt ?? new Date(Date.now() + 2 * 3600_000);
    for (const [i, id] of clipIds.entries()) {
      try {
        // Un clip toutes les 3 heures : évite de saturer les comptes.
        const pubs = await queueClipPublications({
          clipId: id,
          networks,
          scheduledAt: new Date(start.getTime() + i * 3 * 3600_000),
        });
        publicationIds.push(...pubs.map((p) => p.id));
      } catch (err) {
        warnings.push(`Mise en file du clip ${id} impossible : ${(err as Error).message}`);
      }
    }
    steps.push({
      stage: "5 · Publication",
      detail: `${publicationIds.length} publication(s) en file sur ${networks.join(", ")}`,
      ok: publicationIds.length > 0,
    });

    if (opts.flushQueue) {
      const res = await processQueue(publicationIds.length || 20);
      steps.push({
        stage: "5b · Envoi Metricool",
        detail: `${res.scheduled} planifiée(s), ${res.failed} en échec sur ${res.processed} traitée(s)`,
        ok: res.failed === 0,
      });
    }
  }

  await logEvent({
    stage: "ingest",
    entity: `rush:${rush.id}`,
    message: `Pipeline complet terminé — ${clipIds.length} clip(s), ${publicationIds.length} publication(s)`,
    data: { warnings },
  });

  return {
    rushId: rush.id,
    steps,
    momentCount: det.moments,
    hookCount: det.hooks,
    clipIds,
    publicationIds,
    warnings,
  };
}
