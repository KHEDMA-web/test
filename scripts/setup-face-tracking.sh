#!/usr/bin/env bash
# Installe de quoi faire suivre les visages au recadrage vertical.
# Facultatif : sans ça, le rendu retombe sur le recadrage centré.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Dépendances Python"
python3 -m pip install -r requirements.txt

echo "→ Modèle de détection de visage (10 Mo)"
mkdir -p models
curl -fsSL -o models/res10_deploy.prototxt \
  "https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt"
curl -fsSL -o models/res10_ssd.caffemodel \
  "https://raw.githubusercontent.com/opencv/opencv_3rdparty/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000.caffemodel"

echo "→ Vérification"
python3 scripts/face_track.py --video "${1:-}" --start 0 --end 2 2>/dev/null | head -c 200 || true
echo
echo "Terminé. Utilisez \"framing\": \"face\" dans un plan de montage."
