/**
 * Transcription locale — gratuite, sans clé, sans appel réseau payant.
 *
 * S'appuie sur faster-whisper (CTranslate2) via un script Python. Le modèle
 * est téléchargé une fois puis réutilisé hors ligne ; ensuite, transcrire
 * un rush ne coûte que du temps de calcul.
 *
 * C'est le provider à utiliser quand le budget doit rester à zéro. Les
 * providers en ligne restent disponibles pour qui préfère payer de la
 * vitesse.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Segment, TranscriptionProvider, TranscriptionResult } from "./types";

const exec = promisify(execFile);

type PythonOutput = {
  ok: boolean;
  error?: string;
  provider?: string;
  language?: string;
  durationSec?: number;
  segments?: Array<{
    idx: number;
    startSec: number;
    endSec: number;
    text: string;
    confidence?: number;
    words?: Array<{ text: string; start: number; end: number; confidence?: number }> | null;
  }>;
};

export class LocalWhisperProvider implements TranscriptionProvider {
  readonly name = "local-whisper";

  constructor(private readonly model = process.env.CLIPFLOW_WHISPER_MODEL ?? "small") {}

  async transcribe(source: string, opts?: { language?: string }): Promise<TranscriptionResult> {
    const script = path.join(process.cwd(), "scripts", "transcribe_local.py");
    const python = process.env.CLIPFLOW_PYTHON ?? "python3";

    let stdout: string;
    try {
      ({ stdout } = await exec(
        python,
        [script, "--audio", source, "--model", this.model, "--language", opts?.language ?? "fr"],
        {
          maxBuffer: 1024 * 1024 * 64,
          // Un rush d'une heure sur processeur peut être long : on laisse venir.
          timeout: 1000 * 60 * 120,
        },
      ));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error(
          "python3 est introuvable. Installez la transcription locale avec ./scripts/setup-local-transcription.sh",
        );
      }
      throw new Error(`Transcription locale échouée : ${(err as Error).message.slice(0, 300)}`);
    }

    const parsed = JSON.parse(stdout) as PythonOutput;
    if (!parsed.ok) throw new Error(parsed.error ?? "Transcription locale échouée.");

    const segments: Segment[] = (parsed.segments ?? []).map((s) => ({
      idx: s.idx,
      startSec: s.startSec,
      endSec: s.endSec,
      text: s.text,
      confidence: s.confidence,
      words: s.words ?? undefined,
    }));

    return {
      provider: parsed.provider ?? this.name,
      language: parsed.language ?? opts?.language ?? "fr",
      durationSec: parsed.durationSec ?? (segments.at(-1)?.endSec ?? 0),
      segments,
    };
  }
}
