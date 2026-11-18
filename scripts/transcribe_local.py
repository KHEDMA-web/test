#!/usr/bin/env python3
"""
Transcription locale, gratuite, sans clé ni appel payant.

Utilise faster-whisper (CTranslate2) : tourne sur le processeur, accélère
sur une carte NVIDIA si elle est là. Le modèle est téléchargé une fois
puis réutilisé hors ligne.

Sort le même JSON que les providers en ligne, horodatage au mot compris —
indispensable pour les sous-titres en groupes de trois ou quatre mots.

  python3 scripts/transcribe_local.py --audio rush.mp4 --language fr
"""
import argparse
import json
import os
import subprocess
import tempfile
import wave


def extract_audio(source: str) -> str:
    """16 kHz mono : ce que le modèle attend, et ça évite les formats exotiques."""
    fd, wav = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", wav],
        check=True,
    )
    return wav


def read_wav(path: str):
    """
    Lit le WAV en flottants nous-mêmes plutôt que de laisser faster-whisper
    le décoder : ça évite PyAV, dont l'API bouge d'une version à l'autre et
    casse le décodage interne.
    """
    import numpy as np

    with wave.open(path, "rb") as wf:
        frames = wf.readframes(wf.getnframes())
        width = wf.getsampwidth()
    if width != 2:
        raise RuntimeError(f"échantillons sur {width} octets, 16 bits attendus")
    return np.frombuffer(frames, dtype=np.int16).astype("float32") / 32768.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="fichier vidéo ou audio")
    ap.add_argument("--model", default=os.environ.get("CLIPFLOW_WHISPER_MODEL", "small"))
    ap.add_argument("--language", default="fr")
    ap.add_argument("--device", default=os.environ.get("CLIPFLOW_WHISPER_DEVICE", "auto"))
    ap.add_argument("--compute-type", default=os.environ.get("CLIPFLOW_WHISPER_COMPUTE", "int8"))
    ap.add_argument("--beam-size", type=int, default=5)
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({
            "ok": False,
            "error": "faster-whisper n'est pas installé. Lancez ./scripts/setup-local-transcription.sh",
        }))
        return

    if not os.path.exists(args.audio):
        print(json.dumps({"ok": False, "error": f"fichier introuvable : {args.audio}"}))
        return

    wav = None
    try:
        wav = extract_audio(args.audio)
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)

        audio = read_wav(wav)

        segments, info = model.transcribe(
            audio,
            language=args.language or None,
            beam_size=args.beam_size,
            word_timestamps=True,
            # Coupe les silences : moins de calcul, et des bornes plus nettes.
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
        )

        out = []
        for i, seg in enumerate(segments):
            words = [
                {"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3),
                 "confidence": round(w.probability, 3)}
                for w in (seg.words or [])
                if w.word and w.word.strip()
            ]
            out.append({
                "idx": i,
                "startSec": round(seg.start, 3),
                "endSec": round(seg.end, 3),
                "text": seg.text.strip(),
                "confidence": round(getattr(seg, "avg_logprob", 0.0), 3),
                "words": words or None,
            })

        print(json.dumps({
            "ok": True,
            "provider": f"faster-whisper/{args.model}",
            "language": info.language,
            "languageProbability": round(info.language_probability, 3),
            "durationSec": round(info.duration, 3),
            "segments": out,
        }))
    except Exception as exc:  # noqa: BLE001 - le message doit remonter tel quel
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}))
    finally:
        if wav and os.path.exists(wav):
            os.unlink(wav)


if __name__ == "__main__":
    main()
