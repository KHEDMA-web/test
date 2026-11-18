/**
 * Recadrage vertical qui suit les visages.
 *
 * Un plateau filmé en 16:9 recadré au centre coupe les deux interlocuteurs ;
 * le fond flou garde tout le monde mais rend les visages minuscules. Suivre
 * le visage dominant est ce qui change vraiment la qualité d'un clip tiré
 * d'un podcast.
 *
 * Le repérage est fait par un script Python (OpenCV), et FFmpeg applique
 * les positions avec `sendcmd`. Si OpenCV ou le modèle manquent, on le dit
 * et le rendu retombe sur le cadrage demandé par défaut : la plateforme
 * continue de fonctionner sans cette dépendance.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import path from "node:path";
const exec = promisify(execFile);
const SCRIPT = path.join(process.cwd(), "scripts", "face_track.py");
/** Repère les visages sur un intervalle du rush. Ne lève jamais. */
export async function trackFaces(args) {
    const empty = (error) => ({
        ok: false,
        width: 0,
        height: 0,
        cropWidth: 0,
        samples: 0,
        facesFound: 0,
        keyframes: [],
        error,
    });
    try {
        const { stdout } = await exec(args.pythonBin ?? process.env.CLIPFLOW_PYTHON ?? "python3", [
            SCRIPT,
            "--video", args.source,
            "--start", args.startSec.toFixed(3),
            "--end", args.endSec.toFixed(3),
            "--aspect", String(args.aspect ?? 9 / 16),
            "--sample-fps", String(args.sampleFps ?? 5),
        ], { maxBuffer: 1024 * 1024 * 16, timeout: 1000 * 60 * 10 });
        const parsed = JSON.parse(stdout);
        return parsed;
    }
    catch (err) {
        const message = err.code === "ENOENT"
            ? "python3 est introuvable : le suivi de visage est indisponible."
            : `suivi de visage indisponible : ${err.message.slice(0, 200)}`;
        return empty(message);
    }
}
/**
 * Fichier de commandes `sendcmd` : déplace la fenêtre de recadrage au fil
 * du temps. Les temps sont relatifs au début de la coupe, puisque le
 * `setpts` qui précède a remis l'horloge à zéro.
 *
 * Deux détails qui ne pardonnent pas :
 *  - la cible s'écrit `crop@étiquette`, pas l'étiquette seule, sinon la
 *    commande n'atteint jamais le filtre et le cadre reste figé ;
 *  - chaque commande veut un intervalle `début-fin` avec le drapeau
 *    `[enter]` ; un instant sec ne déclenche rien.
 */
export function buildSendcmd(target, keyframes, durationSec) {
    const lines = keyframes.map((k, i) => {
        const end = i + 1 < keyframes.length ? keyframes[i + 1].t : Math.max(k.t + 0.001, durationSec);
        return `${k.t.toFixed(3)}-${end.toFixed(3)} [enter] ${target} x ${k.x};`;
    });
    return lines.join("\n") + "\n";
}
export async function writeSendcmdFile(dir, index, target, keyframes, durationSec) {
    const file = path.join(dir, `track-${index}.cmd`);
    await writeFile(file, buildSendcmd(target, keyframes, durationSec), "utf8");
    return file;
}
/** Une ligne lisible pour le journal et l'interface. */
export function describeTrack(track) {
    if (!track.ok)
        return track.error ?? "suivi indisponible";
    if (track.note)
        return track.note;
    const rate = track.samples ? Math.round((track.facesFound / track.samples) * 100) : 0;
    return `visage repéré sur ${rate} % des images analysées (${track.facesFound}/${track.samples}), ${track.keyframes.length} points de suivi`;
}
