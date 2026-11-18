#!/usr/bin/env python3
"""
Suivi de visage pour le recadrage vertical.

Échantillonne la vidéo, repère les visages, et renvoie la position
horizontale que doit prendre la fenêtre 9:16 au fil du temps. FFmpeg
applique ensuite ces positions avec `sendcmd`.

Sans audio, on ne sait pas qui parle : on suit donc le visage dominant,
et on cadre le groupe quand tous les visages tiennent dans la fenêtre.
C'est ce que donne un suivi de visage honnête — et c'est déjà très
au-dessus d'un recadrage centré sur un plateau filmé en 16:9.

Sortie JSON sur stdout :
  {"ok": true, "width":…, "height":…, "cropWidth":…, "samples":…,
   "facesFound":…, "keyframes":[{"t":0.0,"x":412}, …]}

Usage :
  python3 scripts/face_track.py --video rush.mp4 --start 12.5 --end 48.0
"""
import argparse
import json
import os
import sys

try:
    import cv2
    import numpy as np
except ImportError as exc:  # pragma: no cover - dépend de l'environnement
    print(json.dumps({"ok": False, "error": f"dépendance manquante : {exc}. Installez opencv-python-headless."}))
    sys.exit(0)

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROTO = os.path.join(HERE, "models", "res10_deploy.prototxt")
WEIGHTS = os.path.join(HERE, "models", "res10_ssd.caffemodel")


def load_detector():
    """Détecteur DNN si les poids sont là, sinon cascade de Haar."""
    if os.path.exists(PROTO) and os.path.exists(WEIGHTS):
        try:
            net = cv2.dnn.readNetFromCaffe(PROTO, WEIGHTS)
            return ("dnn", net)
        except Exception:
            pass
    cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    if os.path.exists(cascade_path):
        return ("haar", cv2.CascadeClassifier(cascade_path))
    return (None, None)


def detect(kind, model, frame, min_conf):
    """Renvoie [(x, y, w, h, score)] en pixels de l'image d'origine."""
    h, w = frame.shape[:2]
    if kind == "dnn":
        blob = cv2.dnn.blobFromImage(
            cv2.resize(frame, (300, 300)), 1.0, (300, 300), (104.0, 177.0, 123.0)
        )
        model.setInput(blob)
        out = model.forward()
        faces = []
        for i in range(out.shape[2]):
            score = float(out[0, 0, i, 2])
            if score < min_conf:
                continue
            box = out[0, 0, i, 3:7] * np.array([w, h, w, h])
            x1, y1, x2, y2 = box.astype(int)
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            if x2 - x1 < 12 or y2 - y1 < 12:
                continue
            faces.append((x1, y1, x2 - x1, y2 - y1, score))
        return faces

    if kind == "haar":
        grey = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        found = model.detectMultiScale(grey, scaleFactor=1.15, minNeighbors=5, minSize=(40, 40))
        return [(int(x), int(y), int(fw), int(fh), 1.0) for (x, y, fw, fh) in found]

    return []


def choose_centre(faces, crop_w, frame_w):
    """
    Où viser ?
      - plusieurs visages qui tiennent dans la fenêtre → on cadre le groupe
      - sinon → le visage dominant (surface × confiance)
    """
    if not faces:
        return None
    if len(faces) > 1:
        left = min(f[0] for f in faces)
        right = max(f[0] + f[2] for f in faces)
        if right - left <= crop_w * 0.92:
            return (left + right) / 2.0
    dominant = max(faces, key=lambda f: f[2] * f[3] * f[4])
    return dominant[0] + dominant[2] / 2.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=0.0, help="0 = jusqu'à la fin")
    ap.add_argument("--sample-fps", type=float, default=5.0)
    ap.add_argument("--aspect", type=float, default=9 / 16, help="rapport largeur/hauteur voulu")
    ap.add_argument("--min-confidence", type=float, default=0.35)
    # Zone morte : en dessous, on ne bouge pas, pour éviter le tremblement.
    ap.add_argument("--deadzone", type=float, default=0.012, help="en fraction de la largeur")
    ap.add_argument("--smoothing", type=float, default=0.22, help="0 = figé, 1 = collé au visage")
    args = ap.parse_args()

    if not os.path.exists(args.video):
        print(json.dumps({"ok": False, "error": f"fichier introuvable : {args.video}"}))
        return

    kind, model = load_detector()
    if kind is None:
        print(json.dumps({"ok": False, "error": "aucun détecteur de visage disponible (ni DNN ni Haar)."}))
        return

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "error": "vidéo illisible par OpenCV."}))
        return

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if width == 0 or height == 0:
        cap.release()
        print(json.dumps({"ok": False, "error": "dimensions de la vidéo inconnues."}))
        return

    crop_w = int(round(height * args.aspect))
    crop_w = min(crop_w - (crop_w % 2), width)
    if crop_w >= width:
        cap.release()
        print(json.dumps({
            "ok": True, "width": width, "height": height, "cropWidth": width,
            "samples": 0, "facesFound": 0, "detector": kind, "keyframes": [],
            "note": "la source est déjà au format voulu ou plus étroite : rien à suivre.",
        }))
        return

    end = args.end if args.end > args.start else cap.get(cv2.CAP_PROP_FRAME_COUNT) / max(1.0, cap.get(cv2.CAP_PROP_FPS))
    step = 1.0 / max(0.5, args.sample_fps)
    half = crop_w / 2.0
    deadzone_px = args.deadzone * width

    centre = width / 2.0      # position lissée
    last_emitted = None
    keyframes = []
    samples = 0
    faces_found = 0

    t = args.start
    while t < end:
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000.0)
        ok, frame = cap.read()
        if not ok:
            break
        samples += 1

        faces = detect(kind, model, frame, args.min_confidence)
        target = choose_centre(faces, crop_w, width)
        if target is not None:
            faces_found += 1
            err = target - centre
            # Zone morte contre le tremblement, rattrapage adaptatif contre
            # le retard : un lissage fixe traîne derrière un mouvement ample.
            if abs(err) > deadzone_px:
                reach = min(1.0, abs(err) / (crop_w * 0.5))
                gain = args.smoothing + (1.0 - args.smoothing) * reach * 0.65
                centre += err * gain

        x = int(round(min(max(centre - half, 0), width - crop_w)))
        rel = round(t - args.start, 3)
        if last_emitted is None or abs(x - last_emitted) >= 2:
            keyframes.append({"t": rel, "x": x})
            last_emitted = x
        t += step

    cap.release()

    if not keyframes:
        keyframes.append({"t": 0.0, "x": int((width - crop_w) / 2)})

    print(json.dumps({
        "ok": True,
        "detector": kind,
        "width": width,
        "height": height,
        "cropWidth": crop_w,
        "samples": samples,
        "facesFound": faces_found,
        "keyframes": keyframes,
    }))


if __name__ == "__main__":
    main()
