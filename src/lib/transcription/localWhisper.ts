/**
 * Transcription locale via le binaire `whisper` (openai-whisper) ou
 * `whisper-cli` (whisper.cpp), s'il est installé sur la machine.
 * Aucun appel réseau, aucune clé : utile pour des rushes confidentiels.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Segment, TranscriptionProvider, TranscriptionResult } from "./types";

const exec = promisify(execFile);

type WhisperJson = {
  language?: string;
  segments?: Array<{ start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> }>;
};

export class LocalWhisperProvider implements TranscriptionProvider {
  readonly name = "local-whisper";

  async transcribe(source: string, opts?: { language?: string }): Promise<TranscriptionResult> {
    const outDir = await mkdtemp(path.join(tmpdir(), "clipflow-whisper-"));
    try {
      await exec(
        "whisper",
        [
          source,
          "--model", "small",
          "--output_format", "json",
          "--output_dir", outDir,
          "--word_timestamps", "True",
          ...(opts?.language ? ["--language", opts.language] : []),
        ],
        { maxBuffer: 1024 * 1024 * 64, timeout: 1000 * 60 * 30 },
      );

      const base = path.basename(source).replace(/\.[^.]+$/, "");
      const json = JSON.parse(await readFile(path.join(outDir, `${base}.json`), "utf8")) as WhisperJson;

      const segments: Segment[] = (json.segments ?? []).map((s, i) => ({
        idx: i,
        startSec: s.start,
        endSec: s.end,
        text: s.text.trim(),
        words: (s.words ?? []).map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })),
      }));

      return {
        provider: this.name,
        language: json.language ?? opts?.language ?? "fr",
        durationSec: segments.at(-1)?.endSec ?? 0,
        segments,
      };
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }
}
