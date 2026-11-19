#!/usr/bin/env tsx
/**
 * Du lien au clip, en une commande, sans base de données.
 *
 * C'est le chemin le plus court pour sortir un vrai clip : on donne une
 * source — un fichier local, une VOD Twitch, une vidéo YouTube, n'importe
 * quel lien que yt-dlp sait lire — et on récupère des MP4 verticaux prêts à
 * publier, avec leurs sous-titres incrustés et leur accroche.
 *
 * L'interface et le serveur MCP font la même chose en gardant une trace en
 * base. Ici, rien n'est enregistré : c'est fait pour la première fois, pour
 * un essai, ou pour clipper sans rien configurer.
 *
 *   npx tsx scripts/pipeline.ts --source https://www.twitch.tv/videos/...
 *   npx tsx scripts/pipeline.ts --source rush.mp4 --clips 5 --sortie ./clips
 *
 * Options utiles :
 *   --clips N        nombre de clips visés (3 par défaut)
 *   --sortie DOSSIER où déposer les clips (./clips par défaut)
 *   --langue fr|en   force la langue au lieu de la détecter
 *   --modele M       modèle Whisper : tiny, base, small, medium (base)
 *   --min / --max    bornes de durée d'un clip, en secondes (15 / 75)
 *   --cadrage M      face (défaut), cover ou fit-blur
 *   --section A-B    ne traiter qu'une tranche du rush, en secondes
 *   --garder-rush    ne pas supprimer le rush téléchargé à la fin
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { detectMoments, type DetectedMoment } from "../src/lib/pipeline/moments";
import { generateHeuristicHooks } from "../src/lib/pipeline/hooks";
import { probeMedia, renderMultiCut } from "../src/lib/render/ffmpeg";
import type { Segment } from "../src/lib/transcription/types";

type Options = {
  source: string;
  clips: number;
  sortie: string;
  langue: string | null;
  modele: string;
  min: number;
  max: number;
  cadrage: "face" | "cover" | "fit-blur";
  section: { start: number; end: number } | null;
  garderRush: boolean;
};

const PYTHON = process.env.CLIPFLOW_PYTHON ?? "python3";

/**
 * En dessous de cette confiance moyenne par mot, la transcription est du
 * charabia. Mesuré sur un même rush : 0,92 avec la bonne langue, 0,30 avec
 * la mauvaise. Le seuil est posé largement entre les deux.
 */
const SEUIL_CONFIANCE = 0.65;

function lireOptions(argv: string[]): Options {
  const get = (nom: string): string | undefined => {
    const i = argv.indexOf(`--${nom}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const source = get("source") ?? argv.find((a) => !a.startsWith("--") && a !== argv[0]);
  if (!source) {
    console.error(
      "Il faut une source : --source <lien ou fichier>\n" +
        "  npx tsx scripts/pipeline.ts --source https://www.twitch.tv/videos/123456789\n" +
        "  npx tsx scripts/pipeline.ts --source mon-rush.mp4 --clips 5",
    );
    process.exit(2);
  }

  const sectionBrute = get("section");
  let section: Options["section"] = null;
  if (sectionBrute) {
    const [a, b] = sectionBrute.split("-").map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      console.error(`--section attend « début-fin » en secondes, par exemple 600-1800. Reçu : ${sectionBrute}`);
      process.exit(2);
    }
    section = { start: a, end: b };
  }

  const cadrage = (get("cadrage") ?? "face") as Options["cadrage"];
  if (!["face", "cover", "fit-blur"].includes(cadrage)) {
    console.error(`--cadrage attend face, cover ou fit-blur. Reçu : ${cadrage}`);
    process.exit(2);
  }

  return {
    source,
    clips: Number(get("clips") ?? 3),
    sortie: resolve(get("sortie") ?? "./clips"),
    langue: get("langue") ?? null,
    modele: get("modele") ?? "base",
    min: Number(get("min") ?? 15),
    max: Number(get("max") ?? 75),
    cadrage,
    section,
    garderRush: argv.includes("--garder-rush"),
  };
}

/** Lance une commande et renvoie sa sortie standard. */
function courir(cmd: string, args: string[], label: string): Promise<string> {
  return new Promise((ok, non) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      non(new Error(`${label} : ${cmd} introuvable (${e.message}). Vérifiez qu'il est installé et dans le PATH.`)),
    );
    p.on("close", (code) => (code === 0 ? ok(out) : non(new Error(`${label} a échoué :\n${err.trim() || out.trim()}`))));
  });
}

function estUnLien(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/** Ramène la source à un fichier local, en la téléchargeant s'il le faut. */
async function obtenirRush(o: Options, travail: string): Promise<{ chemin: string; aTelecharge: boolean; titre: string }> {
  if (!estUnLien(o.source)) {
    const chemin = resolve(o.source);
    if (!existsSync(chemin)) throw new Error(`Fichier introuvable : ${chemin}`);
    return { chemin, aTelecharge: false, titre: basename(chemin, extname(chemin)) };
  }

  console.log("① Lecture de la source…");
  const fiche = JSON.parse(
    await courir(PYTHON, ["-I", "scripts/resolve_source.py", "--mode", "probe", "--url", o.source], "La lecture du lien"),
  );
  if (!fiche.ok) throw new Error(fiche.error ?? "source illisible");
  console.log(`   ${fiche.title ?? "sans titre"} — ${fiche.uploader ?? "?"} (${fiche.extractor})`);
  if (fiche.durationSec) console.log(`   durée : ${Math.round(fiche.durationSec / 60)} min`);

  const sortie = join(travail, "rush.mp4");
  if (fiche.isLive) {
    const secondes = o.section ? o.section.end - o.section.start : 600;
    console.log(`   direct en cours : capture de ${Math.round(secondes / 60)} min à partir de maintenant…`);
    const r = JSON.parse(
      await courir(
        PYTHON,
        ["-I", "scripts/resolve_source.py", "--mode", "record", "--url", o.source, "--out", sortie, "--seconds", String(secondes)],
        "La capture du direct",
      ),
    );
    if (!r.ok) throw new Error(r.error ?? "capture impossible");
    return { chemin: r.path, aTelecharge: true, titre: fiche.title ?? "direct" };
  }

  console.log("   téléchargement…");
  const args = ["-I", "scripts/resolve_source.py", "--mode", "download", "--url", o.source, "--out", sortie];
  if (o.section) args.push("--start", String(o.section.start), "--end", String(o.section.end));
  const r = JSON.parse(await courir(PYTHON, args, "Le téléchargement"));
  if (!r.ok) throw new Error(r.error ?? "téléchargement impossible");
  console.log(`   ${(r.sizeBytes / 1024 / 1024).toFixed(0)} Mo récupérés`);
  return { chemin: r.path, aTelecharge: true, titre: fiche.title ?? "rush" };
}

/** Transcription locale, gratuite, avec les timecodes de chaque mot. */
async function transcrire(
  rush: string,
  o: Options,
  travail: string,
): Promise<{ segments: Segment[]; langue: string; confianceMots: number | null }> {
  const wav = join(travail, "audio.wav");
  await courir("ffmpeg", ["-y", "-loglevel", "error", "-i", rush, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], "L'extraction de l'audio");

  const args = ["-I", "scripts/transcribe_local.py", "--audio", wav, "--model", o.modele];
  if (o.langue) args.push("--language", o.langue);
  const brut = JSON.parse(await courir(PYTHON, args, "La transcription"));
  if (!brut.ok) throw new Error(brut.error ?? "transcription impossible");
  const segments = brut.segments as Segment[];
  // La certitude de langue annoncée par Whisper ne vaut rien : mesuré, il
  // donne 100 % sur une langue fausse. La confiance moyenne par mot, elle,
  // sépare nettement — 0,92 sur la bonne langue, 0,30 sur la mauvaise.
  const confs = segments.flatMap((seg) => (seg.words ?? []).map((w) => w.confidence)).filter((c): c is number => typeof c === "number");
  return {
    segments,
    langue: brut.language ?? o.langue ?? "fr",
    confianceMots: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null,
  };
}

/** Un nom de fichier sûr sur Windows comme ailleurs. */
function nomDeFichier(texte: string, repli: string): string {
  const net = texte
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9 _-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return net || repli;
}

async function main() {
  const o = lireOptions(process.argv.slice(2));
  const travail = join(tmpdir(), `clipflow-${Date.now()}`);
  mkdirSync(travail, { recursive: true });
  mkdirSync(o.sortie, { recursive: true });

  let rush: Awaited<ReturnType<typeof obtenirRush>> | null = null;
  try {
    rush = await obtenirRush(o, travail);

    const media = await probeMedia(rush.chemin);
    console.log(`\n② Rush : ${Math.round(media.durationSec)} s, ${media.width}×${media.height}${media.hasAudio ? "" : " — SANS AUDIO"}`);
    if (!media.hasAudio) throw new Error("Ce rush n'a pas de piste audio : rien à transcrire, donc rien à repérer.");

    console.log(`\n③ Transcription locale (modèle ${o.modele})… quelques minutes sur un long rush.`);
    const debut = Date.now();
    const { segments, langue, confianceMots } = await transcrire(rush.chemin, o, travail);
    const mots = segments.reduce((n, s) => n + (s.words?.length ?? 0), 0);
    const sur = confianceMots === null ? "" : `, confiance ${Math.round(confianceMots * 100)} %`;
    console.log(`   ${segments.length} segments, ${mots} mots, langue « ${langue} »${sur}, en ${((Date.now() - debut) / 1000).toFixed(0)} s`);

    const extrait = segments.find((seg) => seg.text.trim().length > 20)?.text.trim().slice(0, 90);
    if (extrait) console.log(`   extrait : « ${extrait}… »`);

    // Une langue mal devinée ne fait pas échouer la chaîne : elle la rend
    // silencieusement inutile. La transcription part en charabia, les
    // lexiques ne mordent sur rien, et les accroches citent des mots qui
    // n'ont jamais été prononcés. On le dit fort plutôt que de rendre des
    // clips que personne ne comprendra.
    if (confianceMots !== null && confianceMots < SEUIL_CONFIANCE) {
      console.log(
        `   ⚠ Transcription peu fiable (${Math.round(confianceMots * 100)} %, on attend plus de ${Math.round(SEUIL_CONFIANCE * 100)} %).` +
          `\n     Le plus souvent c'est la langue qui a été mal devinée — l'extrait ci-dessus` +
          `\n     le dira tout de suite. Relancez avec --langue fr (ou en), au besoin --modele small.`,
      );
    }

    console.log("\n④ Repérage des moments…");
    const moments = detectMoments(segments, {
      language: langue,
      minSeconds: o.min,
      maxSeconds: o.max,
      limit: o.clips,
    });
    if (moments.length === 0) {
      console.log("   Aucun moment au-dessus du seuil. Essayez --min 10 --max 90, ou un rush plus dense.");
      return;
    }

    const choisis: Array<{ moment: DetectedMoment; hook: string }> = moments.map((m) => ({
      moment: m,
      hook: generateHeuristicHooks(m)[0]?.text ?? "",
    }));

    for (const [i, { moment: m, hook }] of choisis.entries()) {
      console.log(`   ${i + 1}. [${m.score}/100] ${m.startSec.toFixed(0)}s → ${m.endSec.toFixed(0)}s — ${m.rationale}`);
      console.log(`      accroche : « ${hook} »`);
    }

    console.log(`\n⑤ Rendu de ${choisis.length} clip(s), cadrage « ${o.cadrage} »…`);
    const faits: string[] = [];
    for (const [i, { moment: m, hook }] of choisis.entries()) {
      const nom = `${String(i + 1).padStart(2, "0")}-${nomDeFichier(hook || rush.titre, `clip-${i + 1}`)}.mp4`;
      const chemin = join(o.sortie, nom);
      process.stdout.write(`   ${nom} … `);
      try {
        const r = await renderMultiCut({
          source: rush.chemin,
          outputPath: chemin,
          cuts: [{ start: m.startSec, end: m.endSec }],
          segments,
          hook,
          framing: o.cadrage,
          burnSubtitles: true,
          normalizeAudio: true,
          hasAudio: true,
          thumbnail: true,
        });
        console.log(`${r.durationSec.toFixed(1)}s, ${(r.sizeBytes / 1024 / 1024).toFixed(1)} Mo`);
        for (const ligne of r.tracking ?? []) console.log(`      ${ligne}`);
        faits.push(chemin);
      } catch (e) {
        // Un clip raté ne doit pas emporter les autres.
        console.log(`échec — ${(e as Error).message.split("\n")[0]}`);
      }
    }

    // Le relevé : ce qui a été retenu et pourquoi, à côté des clips.
    const releve = join(o.sortie, "releve.json");
    writeFileSync(
      releve,
      JSON.stringify(
        {
          source: o.source,
          titre: rush.titre,
          langue,
          rendus: faits.map((f) => basename(f)),
          moments: choisis.map(({ moment, hook }) => ({
            startSec: moment.startSec,
            endSec: moment.endSec,
            score: moment.score,
            raison: moment.rationale,
            accroche: hook,
            transcription: moment.transcript,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    console.log(`\n${faits.length}/${choisis.length} clip(s) dans ${o.sortie}`);
    console.log(`Le détail du repérage : ${releve}`);
    if (faits.length > 0) console.log("Regardez-les avant de publier : le repérage propose, vous décidez.");
  } finally {
    if (rush?.aTelecharge && !o.garderRush) rmSync(rush.chemin, { force: true });
    rmSync(travail, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
