/**
 * Sélection du provider de transcription.
 * Tous exposent la même interface, donc changer de provider ne touche
 * que l'env — jamais le pipeline.
 */
import { config, live } from "../config";
import { MockTranscriptionProvider } from "./mock";
import { OpenAITranscriptionProvider } from "./openai";
import { DeepgramTranscriptionProvider } from "./deepgram";
import { LocalWhisperProvider } from "./localWhisper";
import type { TranscriptionProvider } from "./types";

export * from "./types";

export function getTranscriptionProvider(): TranscriptionProvider {
  if (!live.transcription()) return new MockTranscriptionProvider();
  switch (config.transcription.provider) {
    case "openai":
      return new OpenAITranscriptionProvider();
    case "deepgram":
      return new DeepgramTranscriptionProvider();
    case "local-whisper":
      return new LocalWhisperProvider();
    default:
      return new MockTranscriptionProvider();
  }
}
