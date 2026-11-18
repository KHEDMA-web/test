/**
 * Transcription via l'API OpenAI (Whisper / gpt-4o-transcribe).
 * Endpoint : POST https://api.openai.com/v1/audio/transcriptions
 * `response_format: verbose_json` + `timestamp_granularities[]` pour obtenir
 * les segments et les mots horodatés.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config";
import type { Segment, TranscriptionProvider, TranscriptionResult } from "./types";

type VerboseJson = {
  language?: string;
  duration?: number;
  text?: string;
  segments?: Array<{ id?: number; start: number; end: number; text: string; avg_logprob?: number }>;
  words?: Array<{ word: string; start: number; end: number }>;
};

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly name = "openai";

  constructor(private readonly model = "whisper-1") {}

  async transcribe(source: string, opts?: { language?: string }): Promise<TranscriptionResult> {
    const form = new FormData();
    const isRemote = /^https?:\/\//.test(source);
    const bytes = isRemote
      ? new Uint8Array(await (await fetch(source)).arrayBuffer())
      : new Uint8Array(await readFile(source));

    form.append("file", new Blob([bytes]), path.basename(source) || "audio.mp4");
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    form.append("timestamp_granularities[]", "word");
    if (opts?.language) form.append("language", opts.language);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.transcription.openaiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`OpenAI transcription → ${res.status} : ${await res.text()}`);

    const json = (await res.json()) as VerboseJson;
    const segments: Segment[] = (json.segments ?? []).map((s, i) => ({
      idx: i,
      startSec: s.start,
      endSec: s.end,
      text: s.text.trim(),
      confidence: s.avg_logprob !== undefined ? Math.exp(s.avg_logprob) : undefined,
      words: (json.words ?? [])
        .filter((w) => w.start >= s.start && w.end <= s.end)
        .map((w) => ({ text: w.word, start: w.start, end: w.end })),
    }));

    return {
      provider: this.name,
      language: json.language ?? opts?.language ?? "fr",
      durationSec: json.duration ?? (segments.at(-1)?.endSec ?? 0),
      segments,
    };
  }
}
