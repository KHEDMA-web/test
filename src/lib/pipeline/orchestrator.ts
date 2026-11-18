/**
 * Préparation d'un rush : ingestion → transcription → moments → hooks.
 *
 * Volontairement, l'enchaînement s'arrête AVANT le montage : le montage
 * est une décision éditoriale, prise avec Claude dans le chat à partir du
 * brief. L'option `autoDraft` existe pour dégrossir, pas pour remplacer
 * ce passage.
 */
import { prisma } from "../db";
import { logEvent } from "../log";
import { ingestRush, transcribeRush, detectRushMoments, type IngestInput } from "./ingest";
import { autoPlanFromMoment, renderPlan } from "./clips";
import { buildEditBrief } from "./brief";

export type PrepareOptions = {
  /** Rendre en plus N brouillons automatiques (une coupe par moment). */
  autoDraft?: number;
};

export type PrepareReport = {
  rushId: string;
  steps: Array<{ stage: string; detail: string; ok: boolean }>;
  momentCount: number;
  hookCount: number;
  draftClipIds: string[];
  briefChars: number;
  warnings: string[];
};

export async function prepareRush(input: IngestInput, opts: PrepareOptions = {}): Promise<PrepareReport> {
  const steps: PrepareReport["steps"] = [];
  const warnings: string[] = [];
  const draftClipIds: string[] = [];

  const rush = await ingestRush(input);
  steps.push({
    stage: "1 · Ingestion",
    detail: `« ${rush.title} » — ${rush.durationSec?.toFixed(0) ?? "?"} s, ${rush.width}×${rush.height}`,
    ok: true,
  });

  const tr = await transcribeRush(rush.id);
  steps.push({ stage: "2 · Transcription", detail: `${tr.segments} segments via ${tr.provider}`, ok: true });

  const det = await detectRushMoments(rush.id);
  warnings.push(...det.warnings);
  steps.push({
    stage: "3 · Moments & hooks",
    detail: `${det.moments} moments repérés, ${det.hooks} hooks candidats`,
    ok: true,
  });

  const brief = await buildEditBrief(rush.id);
  steps.push({
    stage: "4 · Brief",
    detail: `Brief de ${(brief.approxChars / 1000).toFixed(1)} k caractères prêt à coller dans le chat`,
    ok: true,
  });

  const draftCount = opts.autoDraft ?? 0;
  if (draftCount > 0) {
    const moments = await prisma.moment.findMany({
      where: { rushId: rush.id },
      orderBy: { score: "desc" },
      take: draftCount,
    });
    for (const m of moments) {
      try {
        const planId = await autoPlanFromMoment(m.id);
        const clip = await renderPlan(planId);
        draftClipIds.push(clip.id);
      } catch (err) {
        warnings.push(`Brouillon du moment ${Math.round(m.startSec)}s échoué : ${(err as Error).message}`);
      }
    }
    steps.push({
      stage: "4b · Brouillons",
      detail: `${draftClipIds.length}/${moments.length} brouillons automatiques rendus`,
      ok: draftClipIds.length > 0,
    });
  }

  await logEvent({
    stage: "brief",
    entity: `rush:${rush.id}`,
    message: `Rush préparé — ${det.moments} moments, ${det.hooks} hooks, brief prêt`,
    data: { warnings },
  });

  return {
    rushId: rush.id,
    steps,
    momentCount: det.moments,
    hookCount: det.hooks,
    draftClipIds,
    briefChars: brief.approxChars,
    warnings,
  };
}
