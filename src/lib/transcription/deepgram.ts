/**
 * Transcription via Deepgram.
 * Endpoint : POST https://api.deepgram.com/v1/listen
 * Auth     : `Authorization: Token <DEEPGRAM_API_KEY>`
 * Options  : smart_format, punctuate, diarize, paragraphs, utterances.
 */
import { readFile } from "node:fs/promises";
import { config } from "../config";
import type { Segment, TranscriptionProvider, TranscriptionResult } from "./types";

type DgWord = { word: string; start: number; end: number; confidence?: number; speaker?: number; punctuated_word?: string };
type DgResponse = {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string; confidence?: number; words?: DgWord[] }>;
    }>;
    utterances?: Array<{
      start: number;
      end: number;
      transcript: string;
      confidence?: number;
      speaker?: number;
      words?: DgWord[];
    }>;
  };
};

export class DeepgramTranscriptionProvider implements TranscriptionProvider {
  readonly name = "deepgram";

  async transcribe(source: string, opts?: { language?: string }): Promise<TranscriptionResult> {
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", "nova-2");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    url.searchParams.set("diarize", "true");
    url.searchParams.set("utterances", "true");
    url.searchParams.set("language", opts?.language ?? "fr");

    const isRemote = /^https?:\/\//.test(source);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${config.transcription.deepgramKey}`,
        "Content-Type": isRemote ? "application/json" : "audio/*",
      },
      body: isRemote ? JSON.stringify({ url: source }) : new Uint8Array(await readFile(source)),
    });
    if (!res.ok) throw new Error(`Deepgram → ${res.status} : ${await res.text()}`);

    const json = (await res.json()) as DgResponse;
    const utterances = json.results?.utterances ?? [];

    const segments: Segment[] = utterances.length
      ? utterances.map((u, i) => ({
          idx: i,
          startSec: u.start,
          endSec: u.end,
          text: u.transcript.trim(),
          speaker: u.speaker !== undefined ? `Locuteur ${u.speaker + 1}` : undefined,
          confidence: u.confidence,
          words: (u.words ?? []).map((w) => ({
            text: w.punctuated_word ?? w.word,
            start: w.start,
            end: w.end,
            confidence: w.confidence,
          })),
        }))
      : // Pas d'utterances : on retombe sur un unique segment.
        [
          {
            idx: 0,
            startSec: 0,
            endSec: json.metadata?.duration ?? 0,
            text: json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "",
            confidence: json.results?.channels?.[0]?.alternatives?.[0]?.confidence,
          },
        ];

    return {
      provider: this.name,
      language: opts?.language ?? "fr",
      durationSec: json.metadata?.duration ?? (segments.at(-1)?.endSec ?? 0),
      segments,
    };
  }
}
