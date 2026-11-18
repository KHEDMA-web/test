#!/usr/bin/env python3
"""
Résout n'importe quel lien en rush exploitable.

yt-dlp sait lire près de deux mille sites : YouTube, Twitch (VOD et direct),
Vimeo, Dailymotion, un fichier déposé sur un Drive public, un simple .mp4…
Ce script n'en expose que ce dont la plateforme a besoin, et renvoie du JSON.

Trois modes :
  probe     les métadonnées, sans rien télécharger
  download  récupère la vidéo, éventuellement une section seulement
  record    capture une fenêtre d'un direct en cours, depuis maintenant

  python3 scripts/resolve_source.py --mode probe --url https://…
"""
import argparse
import json
import os
import subprocess
import sys


def run_json(args: list[str]) -> dict:
    """Appelle yt-dlp et renvoie la fiche JSON de la vidéo."""
    proc = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        raise RuntimeError(clean_error(proc.stderr))
    line = next((l for l in proc.stdout.splitlines() if l.startswith("{")), None)
    if not line:
        raise RuntimeError("yt-dlp n'a renvoyé aucune métadonnée.")
    return json.loads(line)


def clean_error(stderr: str) -> str:
    """Garde la ligne utile de yt-dlp plutôt que toute la pile."""
    lines = [l.strip() for l in stderr.splitlines() if l.strip()]
    for line in lines:
        if line.startswith("ERROR:"):
            return line[6:].strip()
    return lines[-1] if lines else "échec inconnu"


def probe(url: str) -> dict:
    info = run_json(["yt-dlp", "--skip-download", "--dump-single-json", "--no-warnings", url])

    # Une playlist ou une chaîne entière n'est pas un rush : on le dit.
    if info.get("_type") == "playlist":
        entries = info.get("entries") or []
        return {
            "ok": False,
            "kind": "playlist",
            "title": info.get("title"),
            "entryCount": len(entries),
            "error": "Ce lien est une playlist ou une chaîne, pas une vidéo. Donnez le lien d'une vidéo précise.",
            "entries": [
                {"title": e.get("title"), "url": e.get("webpage_url") or e.get("url"), "durationSec": e.get("duration")}
                for e in entries[:20]
                if e
            ],
        }

    return {
        "ok": True,
        "kind": "live" if info.get("is_live") else "video",
        "id": info.get("id"),
        "title": info.get("title"),
        "description": (info.get("description") or "")[:1000],
        "uploader": info.get("uploader") or info.get("channel"),
        "durationSec": info.get("duration"),
        "isLive": bool(info.get("is_live")),
        "wasLive": bool(info.get("was_live")),
        "extractor": info.get("extractor_key"),
        "webpageUrl": info.get("webpage_url") or url,
        "thumbnail": info.get("thumbnail"),
        "width": info.get("width"),
        "height": info.get("height"),
        "fps": info.get("fps"),
        "language": info.get("language"),
        "uploadDate": info.get("upload_date"),
    }


def download(url: str, out: str, max_height: int, start: float | None, end: float | None) -> dict:
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    args = [
        "yt-dlp",
        "--no-warnings",
        "--no-playlist",
        # Un format déjà fusionné quand c'est possible, sinon meilleur couple.
        "-f", f"bv*[height<={max_height}]+ba/b[height<={max_height}]/b",
        "--merge-output-format", "mp4",
        "-o", out,
    ]
    if start is not None and end is not None and end > start:
        # Ne récupère que la tranche voulue : décisif sur un direct de six heures.
        args += ["--download-sections", f"*{start}-{end}", "--force-keyframes-at-cuts"]

    # Même cascade de replis qu'au probe : le contrôle anti-robot frappe
    # aussi le téléchargement.
    last = None
    for extra in CLIENT_FALLBACKS:
        last = subprocess.run(args + cookie_args() + extra + [url], capture_output=True, text=True, timeout=60 * 90)
        if last.returncode == 0:
            break
        if not is_bot_check(last.stderr):
            break

    if last is None or last.returncode != 0:
        message = clean_error(last.stderr) if last else "échec inconnu"
        if is_bot_check(message):
            raise RuntimeError(
                "YouTube exige une vérification depuis cette adresse. Depuis une connexion "
                "domestique, ça passe en général sans rien faire. Sinon, exportez vos cookies "
                "dans un fichier et renseignez CLIPFLOW_YTDLP_COOKIES avec son chemin."
            )
        raise RuntimeError(message)

    # yt-dlp peut changer l'extension au moment de la fusion.
    path = out if os.path.exists(out) else find_output(out)
    if not path:
        raise RuntimeError("téléchargement terminé mais fichier introuvable")
    return {"ok": True, "path": path, "sizeBytes": os.path.getsize(path)}


def find_output(expected: str) -> str | None:
    folder = os.path.dirname(expected) or "."
    stem = os.path.splitext(os.path.basename(expected))[0]
    for name in os.listdir(folder):
        if name.startswith(stem):
            return os.path.join(folder, name)
    return None


def record(url: str, out: str, seconds: int, max_height: int) -> dict:
    """
    Capture un direct à partir de maintenant.

    On ne peut pas remonter le temps sur un direct : ce qui est déjà passé
    n'est pas récupérable (sauf rediffusion). On enregistre donc une fenêtre
    depuis l'instant de l'appel, et le rush commence là.
    """
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    args = [
        "yt-dlp",
        "--no-warnings",
        "--no-part",
        "-f", f"b[height<={max_height}]/bv*[height<={max_height}]+ba/b",
        "--downloader", "ffmpeg",
        "--downloader-args", f"ffmpeg_i:-t {seconds}",
        "-o", out,
        url,
    ]
    proc = subprocess.run(args, capture_output=True, text=True, timeout=seconds + 600)
    path = out if os.path.exists(out) else find_output(out)
    if not path:
        raise RuntimeError(clean_error(proc.stderr))
    return {"ok": True, "path": path, "sizeBytes": os.path.getsize(path), "recordedSeconds": seconds}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--mode", choices=["probe", "download", "record"], default="probe")
    ap.add_argument("--out", help="chemin de sortie (download et record)")
    ap.add_argument("--max-height", type=int, default=1080)
    ap.add_argument("--start", type=float)
    ap.add_argument("--end", type=float)
    ap.add_argument("--seconds", type=int, default=600, help="durée de capture d'un direct")
    args = ap.parse_args()

    try:
        if args.mode == "probe":
            print(json.dumps(probe(args.url)))
        elif args.mode == "download":
            if not args.out:
                raise RuntimeError("--out est requis en mode download")
            print(json.dumps(download(args.url, args.out, args.max_height, args.start, args.end)))
        else:
            if not args.out:
                raise RuntimeError("--out est requis en mode record")
            print(json.dumps(record(args.url, args.out, args.seconds, args.max_height)))
    except FileNotFoundError:
        print(json.dumps({"ok": False, "error": "yt-dlp n'est pas installé. python3 -m pip install yt-dlp"}))
    except subprocess.TimeoutExpired:
        print(json.dumps({"ok": False, "error": "délai dépassé : la source est trop longue ou trop lente."}))
    except Exception as exc:  # noqa: BLE001 — le message doit remonter tel quel
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
