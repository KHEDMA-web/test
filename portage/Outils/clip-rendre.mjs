/**
 * Rendu vidéo — FFmpeg en child_process.
 *
 * Produit le brouillon automatique d'un clip : découpe du moment, passage en
 * 9:16, sous-titres incrustés, hook en overlay, audio normalisé pour les
 * réseaux. C'est la moitié « auto » du montage hybride ; le clipper peut
 * ensuite déposer sa propre version, qui prend le relais.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, stat, rm, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildAss, remapSegmentsForCuts } from "./sous-titres.mjs";
import { trackFaces, writeSendcmdFile, describeTrack } from "./suivi-visage.mjs";
const exec = promisify(execFile);
/** Lit les caractéristiques d'un fichier ou d'une URL. */
export async function probeMedia(source) {
    const { stdout } = await exec("ffprobe", [
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        source,
    ], { maxBuffer: 1024 * 1024 * 8 });
    const json = JSON.parse(stdout);
    const video = json.streams?.find((s) => s.codec_type === "video");
    const audio = json.streams?.find((s) => s.codec_type === "audio");
    let fps = null;
    if (video?.r_frame_rate && video.r_frame_rate.includes("/")) {
        const [num, den] = video.r_frame_rate.split("/").map(Number);
        if (den > 0)
            fps = Number((num / den).toFixed(3));
    }
    let sizeBytes = json.format?.size ? Number(json.format.size) : null;
    if (sizeBytes === null && !/^https?:\/\//.test(source)) {
        try {
            sizeBytes = (await stat(source)).size;
        }
        catch {
            sizeBytes = null;
        }
    }
    return {
        durationSec: Number(json.format?.duration ?? video?.duration ?? 0),
        width: video?.width ?? null,
        height: video?.height ?? null,
        fps,
        hasAudio: Boolean(audio),
        sizeBytes,
        mimeType: json.format?.format_name ? `video/${json.format.format_name.split(",")[0]}` : null,
    };
}
/**
 * Chaîne de filtres qui amène une coupe au format vertical.
 * Renvoie le fragment de graphe et l'étiquette de sortie.
 */
function framingChain(mode, i, w, h, zoom) {
    const graph = [];
    const src = `c${i}`;
    const trimmed = `${src}t`;
    if (mode === "fit-blur") {
        // Le plan entier reste visible, les bandes sont remplies par un flou de lui-même.
        graph.push(`[${trimmed}]split=2[${src}bg][${src}fg]`);
        graph.push(`[${src}bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=28,eq=brightness=-0.12[${src}bgb]`);
        graph.push(`[${src}fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[${src}fgs]`);
        graph.push(`[${src}bgb][${src}fgs]overlay=(W-w)/2:(H-h)/2[${src}f]`);
    }
    else if (mode === "fit-bars") {
        graph.push(`[${trimmed}]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black[${src}f]`);
    }
    else {
        graph.push(`[${trimmed}]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[${src}f]`);
    }
    // Le zoom s'applique après le cadrage : il vaut pour les trois modes.
    if (zoom && zoom > 1.001) {
        const z = Math.min(1.5, zoom);
        graph.push(`[${src}f]scale=iw*${z.toFixed(3)}:ih*${z.toFixed(3)},crop=${w}:${h}[${src}z]`);
        return { graph, label: `${src}z` };
    }
    return { graph, label: `${src}f` };
}
/** Échappe un chemin pour l'option `filename` du filtre `ass`. */
function escapeFilterPath(p) {
    return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/,/g, "\\,");
}
/**
 * Exécute un plan de montage : découpe, recolle, cadre en 9:16, incruste
 * les sous-titres et le hook, normalise l'audio. Une seule passe FFmpeg.
 */
export async function renderMultiCut(args) {
    const w = args.width ?? 1080;
    const h = args.height ?? 1920;
    const fps = args.fps ?? 30;
    const crf = args.crf ?? 20;
    const framing = args.framing ?? "cover";
    const burn = args.burnSubtitles ?? true;
    const normalize = args.normalizeAudio ?? true;
    const hasAudio = args.hasAudio ?? true;
    const cuts = args.cuts.filter((c) => c.end > c.start);
    if (cuts.length === 0)
        throw new Error("Aucune coupe à rendre.");
    const totalDuration = cuts.reduce((s, c) => s + (c.end - c.start), 0);
    await mkdir(path.dirname(args.outputPath), { recursive: true });
    const workDir = await mkdtemp(path.join(os.tmpdir(), "clipflow-render-"));
    try {
        const graph = [];
        const videoLabels = [];
        const audioLabels = [];
        const tracking = [];
        for (const [i, cut] of cuts.entries()) {
            graph.push(`[0:v]trim=start=${cut.start.toFixed(3)}:end=${cut.end.toFixed(3)},setpts=PTS-STARTPTS[c${i}t]`);
            let label;
            if (framing === "face") {
                const track = await trackFaces({ source: args.source, startSec: cut.start, endSec: cut.end, aspect: w / h });
                tracking.push(`coupe ${i + 1} : ${describeTrack(track)}`);
                if (track.ok && track.keyframes.length > 0 && track.cropWidth > 0 && track.cropWidth < track.width) {
                    // `sendcmd` déplace la fenêtre au fil du temps ; il doit précéder
                    // le `crop` qu'il pilote, et le crop porte une étiquette unique.
                    // Étiquette propre à cette coupe : les commandes ne doivent pas
                    // atteindre le recadrage des autres coupes du même graphe.
                    const cropLabel = `fc${i}`;
                    const cmdFile = await writeSendcmdFile(workDir, i, `crop@${cropLabel}`, track.keyframes, cut.end - cut.start);
                    graph.push(`[c${i}t]sendcmd=f='${escapeFilterPath(cmdFile)}',` +
                        `crop@${cropLabel}=w=${track.cropWidth}:h=${track.height}:x=${track.keyframes[0].x}:y=0,` +
                        `scale=${w}:${h}[c${i}f]`);
                    label = `c${i}f`;
                }
                else {
                    // Suivi indisponible : on retombe sur le recadrage centré plutôt
                    // que de faire échouer le rendu.
                    tracking.push(`coupe ${i + 1} : repli sur le recadrage centré`);
                    // Sans le zoom : le bloc commun plus bas s'en charge pour le
                    // cadrage « face ». Le passer ici l'appliquerait deux fois et
                    // réécrirait la même étiquette, ce que ffmpeg refuse.
                    const fallback = framingChain("cover", i, w, h);
                    graph.push(...fallback.graph);
                    label = fallback.label;
                }
            }
            else {
                const { graph: frame, label: framed } = framingChain(framing, i, w, h, cut.zoom);
                graph.push(...frame);
                label = framed;
            }
            // Le zoom du plan s'applique après le suivi, comme pour les autres cadrages.
            if (framing === "face" && cut.zoom && cut.zoom > 1.001) {
                const z = Math.min(1.5, cut.zoom);
                graph.push(`[${label}]scale=iw*${z.toFixed(3)}:ih*${z.toFixed(3)},crop=${w}:${h}[c${i}z]`);
                label = `c${i}z`;
            }
            // `concat` exige un ratio de pixel identique sur toutes ses entrées ;
            // un zoom le modifie légèrement, d'où la normalisation explicite.
            graph.push(`[${label}]setsar=1,format=yuv420p[v${i}]`);
            videoLabels.push(`v${i}`);
            if (hasAudio) {
                graph.push(`[0:a]atrim=start=${cut.start.toFixed(3)}:end=${cut.end.toFixed(3)},asetpts=PTS-STARTPTS[c${i}a]`);
                audioLabels.push(`c${i}a`);
            }
        }
        // Recollage des coupes dans l'ordre donné par le plan.
        const concatInputs = hasAudio
            ? videoLabels.map((v, i) => `[${v}][${audioLabels[i]}]`).join("")
            : videoLabels.map((v) => `[${v}]`).join("");
        graph.push(`${concatInputs}concat=n=${cuts.length}:v=1:a=${hasAudio ? 1 : 0}${hasAudio ? "[vc][ac]" : "[vc]"}`);
        // Sous-titres : les temps du rush sont projetés sur la timeline montée.
        const needsAss = burn || Boolean(args.hook) || Boolean(args.captionOverrides?.length);
        let videoTail = "vc";
        if (needsAss) {
            const remapped = burn ? remapSegmentsForCuts(args.segments ?? [], cuts) : [];
            const overrides = (args.captionOverrides ?? []).map((o, i) => ({
                idx: 10_000 + i,
                startSec: o.start,
                endSec: o.end,
                text: o.text,
            }));
            const ass = buildAss({
                // Les segments sont déjà en temps de sortie : la fenêtre part de 0.
                segments: [...remapped, ...overrides],
                clipStartSec: 0,
                clipEndSec: totalDuration,
                hook: args.hook ?? null,
                style: { width: w, height: h },
            });
            const assPath = path.join(workDir, "subs.ass");
            await writeFile(assPath, ass, "utf8");
            graph.push(`[vc]ass=filename='${escapeFilterPath(assPath)}':fontsdir='${escapeFilterPath("/usr/share/fonts")}'[vs]`);
            videoTail = "vs";
        }
        graph.push(`[${videoTail}]fps=${fps},format=yuv420p[vout]`);
        if (hasAudio && normalize) {
            // Cible -14 LUFS : le niveau attendu par les plateformes sociales.
            graph.push(`[ac]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`);
        }
        const ffArgs = [
            "-hide_banner",
            "-y",
            // Quatre cœurs au plus, jamais la carte graphique : un rendu ne doit
            // pas confisquer la machine pendant qu'on travaille à côté.
            "-threads", "4",
            "-filter_threads", "4",
            "-i", args.source,
            "-filter_complex", graph.join(";"),
            "-map", "[vout]",
            ...(hasAudio ? ["-map", normalize ? "[aout]" : "[ac]"] : ["-an"]),
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", String(crf),
            "-profile:v", "high",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k", "-ar", "48000"] : []),
            args.outputPath,
        ];
        const { stderr } = await exec("ffmpeg", ffArgs, {
            maxBuffer: 1024 * 1024 * 32,
            timeout: 1000 * 60 * 25,
        });
        let thumbnailPath = null;
        if (args.thumbnail !== false) {
            thumbnailPath = args.outputPath.replace(/\.\w+$/, "") + ".jpg";
            await exec("ffmpeg", [
                "-hide_banner", "-y",
                "-threads", "2",
                "-ss", Math.min(1.2, totalDuration / 2).toFixed(2),
                "-i", args.outputPath,
                "-frames:v", "1",
                "-q:v", "3",
                thumbnailPath,
            ], { maxBuffer: 1024 * 1024 * 8 });
        }
        const out = await stat(args.outputPath);
        return {
            outputPath: args.outputPath,
            thumbnailPath,
            durationSec: totalDuration,
            sizeBytes: out.size,
            command: ["ffmpeg", ...ffArgs].join(" "),
            log: stderr.slice(-4000),
            cuts,
            tracking: tracking.length ? tracking : undefined,
            recipe: {
                cuts: cuts.length,
                totalDuration: Number(totalDuration.toFixed(2)),
                framing,
                width: w,
                height: h,
                fps,
                crf,
                burnSubtitles: burn,
                normalizeAudio: normalize && hasAudio,
                hasAudio,
                hook: args.hook ?? null,
            },
        };
    }
    finally {
        await rm(workDir, { recursive: true, force: true });
    }
}
/** Petit rush de test, pour vérifier le pipeline sans fichier source. */
export async function generateTestRush(outputPath, durationSec = 180) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await exec("ffmpeg", [
        "-hide_banner", "-y",
        "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${durationSec}`,
        "-f", "lavfi", "-i", `sine=frequency=220:duration=${durationSec}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "64k",
        "-shortest",
        outputPath,
    ], { maxBuffer: 1024 * 1024 * 16, timeout: 1000 * 60 * 10 });
    return probeMedia(outputPath);
}
