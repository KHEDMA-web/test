/**
 * Étage 2 — ingestion d'un rush, puis étage 3 enchaîné :
 * sonde → transcription → détection des moments → hooks.
 *
 * Chaque étape est reprise séparément (on peut relancer la détection sans
 * refaire la transcription) et journalisée dans PipelineEvent.
 */
import { prisma } from "../db";
import { logEvent, timed } from "../log";
import { getTranscriptionProvider } from "../transcription";
import type { Segment } from "../transcription/types";
import { probeMedia } from "../render/ffmpeg";
import { detectMoments, DETECTOR_VERSION } from "./moments";
import { generateHooks } from "./hooks";
import type { Rush, RushOrigin } from "@prisma/client";

export type IngestInput = {
  title: string;
  description?: string;
  clientId?: string | null;
  uploaderId?: string | null;
  filePath?: string | null;
  sourceUrl?: string | null;
  language?: string | null;
  origin?: RushOrigin;
  sourceNote?: string | null;
  clipsTarget?: number;
  dueAt?: Date | null;
};

/** Enregistre le rush et lit ses caractéristiques techniques. */
export async function ingestRush(input: IngestInput): Promise<Rush> {
  const source = input.filePath ?? input.sourceUrl;
  if (!source) throw new Error("Un rush nécessite un fichier ou une URL source.");

  const rush = await prisma.rush.create({
    data: {
      title: input.title,
      description: input.description,
      clientId: input.clientId ?? null,
      uploaderId: input.uploaderId ?? null,
      filePath: input.filePath ?? null,
      sourceUrl: input.sourceUrl ?? null,
      language: input.language ?? "fr",
      origin: input.origin ?? "CLIENT_UPLOAD",
      sourceNote: input.sourceNote ?? null,
      clipsTarget: input.clipsTarget ?? 3,
      dueAt: input.dueAt ?? null,
      status: "PROBING",
    },
  });

  await logEvent({ stage: "ingest", entity: `rush:${rush.id}`, message: `Rush « ${rush.title} » reçu` });

  try {
    const probe = await probeMedia(source);
    return await prisma.rush.update({
      where: { id: rush.id },
      data: {
        durationSec: probe.durationSec,
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        hasAudio: probe.hasAudio,
        sizeBytes: probe.sizeBytes ? BigInt(probe.sizeBytes) : null,
        mimeType: probe.mimeType,
        status: "UPLOADED",
      },
    });
  } catch (err) {
    await prisma.rush.update({
      where: { id: rush.id },
      data: { status: "FAILED", error: `Sonde impossible : ${(err as Error).message}` },
    });
    throw err;
  }
}

/** Transcrit le rush et enregistre les segments horodatés. */
export async function transcribeRush(rushId: string): Promise<{ provider: string; segments: number }> {
  const rush = await prisma.rush.findUniqueOrThrow({ where: { id: rushId } });
  const source = rush.filePath ?? rush.sourceUrl;
  if (!source) throw new Error("Rush sans source exploitable.");

  await prisma.rush.update({
    where: { id: rushId },
    data: { status: "TRANSCRIBING", transcriptStatus: "RUNNING", error: null },
  });

  try {
    const provider = getTranscriptionProvider();
    const result = await timed(
      { stage: "transcribe", entity: `rush:${rushId}`, message: `Transcription via ${provider.name}` },
      () =>
        provider.transcribe(source, {
          language: rush.language ?? "fr",
          durationSec: rush.durationSec ?? undefined,
        }),
    );

    await prisma.$transaction([
      prisma.transcriptSegment.deleteMany({ where: { rushId } }),
      prisma.transcriptSegment.createMany({
        data: result.segments.map((s) => ({
          rushId,
          idx: s.idx,
          startSec: s.startSec,
          endSec: s.endSec,
          text: s.text,
          speaker: s.speaker,
          confidence: s.confidence,
          words: (s.words ?? undefined) as never,
        })),
      }),
      prisma.rush.update({
        where: { id: rushId },
        data: {
          transcriptStatus: "DONE",
          transcriptProvider: result.provider,
          language: result.language,
          durationSec: rush.durationSec ?? result.durationSec,
          status: "DETECTING",
        },
      }),
    ]);

    return { provider: result.provider, segments: result.segments.length };
  } catch (err) {
    await prisma.rush.update({
      where: { id: rushId },
      data: { transcriptStatus: "FAILED", status: "FAILED", error: (err as Error).message },
    });
    throw err;
  }
}

function toSegments(rows: Array<{ idx: number; startSec: number; endSec: number; text: string; speaker: string | null; confidence: number | null; words: unknown }>): Segment[] {
  return rows.map((r) => ({
    idx: r.idx,
    startSec: r.startSec,
    endSec: r.endSec,
    text: r.text,
    speaker: r.speaker ?? undefined,
    confidence: r.confidence ?? undefined,
    words: (r.words as Segment["words"]) ?? undefined,
  }));
}

/** Détecte les meilleurs moments puis génère leurs hooks. */
export async function detectRushMoments(
  rushId: string,
  opts: { limit?: number; minSeconds?: number; maxSeconds?: number } = {},
): Promise<{ moments: number; hooks: number; warnings: string[] }> {
  const rush = await prisma.rush.findUniqueOrThrow({
    where: { id: rushId },
    include: { client: true },
  });
  const rows = await prisma.transcriptSegment.findMany({ where: { rushId }, orderBy: { idx: "asc" } });
  if (rows.length === 0) throw new Error("Aucun segment transcrit : lancer la transcription d'abord.");

  const segments = toSegments(rows);
  const detected = detectMoments(segments, {
    minSeconds: opts.minSeconds ?? rush.client?.minClipSeconds ?? 15,
    maxSeconds: opts.maxSeconds ?? rush.client?.maxClipSeconds ?? 75,
    limit: opts.limit ?? rush.client?.clipsPerRush ?? 8,
  });

  // On repart de zéro : la détection est idempotente, mais on conserve les
  // moments déjà transformés en clip pour ne pas casser les liens existants.
  await prisma.moment.deleteMany({ where: { rushId, status: { not: "CLIPPED" } } });

  const warnings: string[] = [];
  let hookCount = 0;
  let rank = 0;

  for (const m of [...detected].sort((a, b) => b.score - a.score)) {
    rank += 1;
    const moment = await prisma.moment.create({
      data: {
        rushId,
        startSec: m.startSec,
        endSec: m.endSec,
        score: m.score,
        scoreBreakdown: { criteria: m.criteria, penalties: m.penalties } as never,
        rationale: m.rationale,
        transcript: m.transcript,
        keywords: m.keywords,
        emotion: m.emotion,
        rank,
        detector: DETECTOR_VERSION,
        status: rank <= 3 ? "SELECTED" : "CANDIDATE",
      },
    });

    const { hooks, provider, warning } = await generateHooks(m, {
      guidelines: rush.client?.hookGuidelines,
    });
    if (warning && !warnings.includes(warning)) warnings.push(warning);

    await prisma.hook.createMany({
      data: hooks.map((h, i) => ({
        momentId: moment.id,
        text: h.text,
        style: h.style,
        score: h.score,
        scoreBreakdown: h.scoreBreakdown as never,
        provider: h.provider,
        variant: i,
        // Le meilleur hook est présélectionné, le monteur peut en changer.
        selected: i === 0,
      })),
    });
    hookCount += hooks.length;

    await logEvent({
      stage: "hook",
      entity: `moment:${moment.id}`,
      message: `${hooks.length} hook(s) générés via ${provider}`,
      data: { best: hooks[0]?.text, score: hooks[0]?.score },
    });
  }

  await prisma.rush.update({
    where: { id: rushId },
    data: { status: "READY", detectionAt: new Date() },
  });

  await logEvent({
    stage: "detect",
    entity: `rush:${rushId}`,
    message: `${detected.length} moment(s) retenus sur ${segments.length} segments`,
    data: { scores: detected.map((d) => d.score) },
  });

  return { moments: detected.length, hooks: hookCount, warnings };
}
