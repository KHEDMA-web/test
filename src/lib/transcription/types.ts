export type Word = { text: string; start: number; end: number; confidence?: number };

export type Segment = {
  idx: number;
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
  confidence?: number;
  words?: Word[];
};

export type TranscriptionResult = {
  provider: string;
  language: string;
  durationSec: number;
  segments: Segment[];
};

export interface TranscriptionProvider {
  readonly name: string;
  /** `source` est un chemin local ou une URL publique. */
  transcribe(source: string, opts?: { language?: string; durationSec?: number }): Promise<TranscriptionResult>;
}
