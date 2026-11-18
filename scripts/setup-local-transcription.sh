#!/usr/bin/env bash
# Transcription locale : gratuite, sans clé, sans appel réseau payant.
# Le modèle est téléchargé une fois, puis tout tourne hors ligne.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Installation de faster-whisper"
python3 -m pip install --quiet faster-whisper

MODEL="${CLIPFLOW_WHISPER_MODEL:-small}"
echo "→ Téléchargement du modèle « $MODEL » (une seule fois)"
python3 - <<PY
from faster_whisper import WhisperModel
WhisperModel("${MODEL}", device="auto", compute_type="int8")
print("modèle prêt")
PY

cat <<'MSG'

Terminé. Dans .env :

  TRANSCRIPTION_PROVIDER="local-whisper"

Modèles, du plus rapide au plus juste : tiny, base, small, medium, large-v3.
« small » est le bon compromis sur processeur. Avec une carte NVIDIA :

  CLIPFLOW_WHISPER_DEVICE=cuda
  CLIPFLOW_WHISPER_COMPUTE=float16

MSG
