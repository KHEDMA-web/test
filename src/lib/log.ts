import { prisma } from "./db";

export type Stage =
  | "whop"
  | "ingest"
  | "transcribe"
  | "detect"
  | "hook"
  | "brief"
  | "plan"
  | "render"
  | "review"
  | "publish"
  | "deliver";

/** Journalise une étape du pipeline (table PipelineEvent) sans jamais faire échouer l'appelant. */
export async function logEvent(args: {
  stage: Stage;
  entity: string;
  message: string;
  level?: "info" | "warn" | "error";
  data?: unknown;
  durationMs?: number;
}): Promise<void> {
  try {
    await prisma.pipelineEvent.create({
      data: {
        stage: args.stage,
        entity: args.entity,
        message: args.message,
        level: args.level ?? "info",
        data: (args.data ?? undefined) as never,
        durationMs: args.durationMs,
      },
    });
  } catch (err) {
    console.error("[pipeline-log]", args.stage, args.message, err);
  }
}

/** Mesure une étape et la journalise, succès comme échec. */
export async function timed<T>(
  meta: { stage: Stage; entity: string; message: string },
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    await logEvent({ ...meta, durationMs: Date.now() - t0 });
    return out;
  } catch (err) {
    await logEvent({
      ...meta,
      level: "error",
      message: `${meta.message} — échec : ${(err as Error).message}`,
      durationMs: Date.now() - t0,
    });
    throw err;
  }
}
