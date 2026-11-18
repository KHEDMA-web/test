/**
 * Le clipping dans le circuit de TheGlobalFarm.
 *
 * Écrit d'après la documentation du projet (magasin.mjs, taches.mjs,
 * api.mjs) sans accès au code réel : les appels suivent les contrats
 * décrits, ils sont à relire avant de servir.
 *
 * Principe retenu : un clip est un sujet comme les autres. Il hérite de
 * « À juger », de la File du PC, du rendu, du Drive, de Metricool et des
 * statistiques sans qu'aucune étape nouvelle soit ajoutée.
 *
 * Ce qui change par rapport à un sujet ordinaire :
 *   - pas d'ElevenLabs : la voix est celle de la source, découpée
 *   - pas de miniature Gemini : une image tirée de la vidéo suffit
 *   - le rendu passe par clip.mjs et non par rendre.mjs
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { mkdir, copyFile } from "node:fs/promises";

import * as M from "./magasin.mjs";
import { lancer, progresser } from "./taches.mjs";
import { demander } from "./generation.mjs";

const exec = promisify(execFile);
const OUTILS = "Montage/Outils";

/**
 * Importe une vidéo longue dans une page.
 * Un lien passe par yt-dlp, un fichier déposé est simplement rangé.
 */
export async function importerSource(page, { lien, fichier, titre, debut, fin, minutesDirect }) {
  const dossier = path.join("Pages", page.dossier, "Sources", M.nomDossier(titre ?? "source"));
  await mkdir(dossier, { recursive: true });
  const cible = path.join(dossier, "source.mp4");

  lancer(
    "clips",
    `Source de « ${titre ?? lien} »`,
    { page: page.id },
    async (fiche) => {
      if (fichier) {
        progresser(fiche, "Rangement du fichier", 20);
        await copyFile(fichier, cible);
      } else {
        progresser(fiche, "Récupération de la source", 20);
        const args = ["--mode", minutesDirect ? "record" : "download", "--url", lien, "--out", cible];
        if (minutesDirect) args.push("--seconds", String(Math.round(minutesDirect * 60)));
        else if (debut !== undefined && fin !== undefined) args.push("--start", String(debut), "--end", String(fin));
        const { stdout } = await exec("python3", [`${OUTILS}/source.py`, ...args], { maxBuffer: 1 << 26 });
        const res = JSON.parse(stdout);
        if (!res.ok) throw new Error(res.error);
      }

      progresser(fiche, "Extraction de l'audio", 45);
      const wav = path.join(dossier, "audio.wav");
      await exec("node", [`${OUTILS}/rush-audio.mjs`, dossier]);

      progresser(fiche, "Transcription", 60);
      const minutage = path.join(dossier, "transcription.json");
      await exec(process.env.PYTHON_TRANSCRIPTION, [`${OUTILS}/transcrire.py`, wav, minutage]);

      progresser(fiche, "Repérage des moments", 85);
      const { stdout } = await exec("node", [`${OUTILS}/clip.mjs`, "moments", minutage], { maxBuffer: 1 << 26 });
      const repere = JSON.parse(stdout);

      M.annoncer(`${repere.moments.length} moments repérés dans « ${titre} », ils attendent dans À juger`, page);
      await proposerClips(page, dossier, repere);
    },
    (e) => M.annoncer(`Source « ${titre} » en échec : ${e.message}`, page),
  );

  return dossier;
}

/**
 * Claude choisit les montages parmi les moments repérés, puis chaque
 * montage devient un sujet à l'étape idée.
 *
 * Les moments ne sont pas une consigne : ils sont fournis notés, et Claude
 * peut couper ailleurs ou recoller deux passages distants. C'est pour ça
 * que le schéma attend des coupes, au pluriel.
 */
export async function proposerClips(page, dossierSource, repere) {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["clips"],
    properties: {
      clips: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["titre", "accroche", "coupes"],
          properties: {
            titre: { type: "string" },
            accroche: { type: "string", description: "58 caractères au plus, tenu par ce qui est dit" },
            coupes: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["debut", "fin"],
                properties: {
                  debut: { type: "number" },
                  fin: { type: "number" },
                  note: { type: "string" },
                  zoom: { type: "number" },
                },
              },
            },
            cadrage: { type: "string", enum: ["visage", "centre", "flou"] },
            pourquoi: { type: "string" },
          },
        },
      },
    },
  };

  const reponse = await demander({
    page,
    schema,
    invite: [
      "Tu montes des clips verticaux pour cette page.",
      "Voici les passages repérés automatiquement, avec leur note et leur texte.",
      "Ce sont des indices, pas des consignes : tu peux couper ailleurs, et surtout",
      "retirer une digression au milieu d'un passage en donnant plusieurs coupes.",
      JSON.stringify(repere.moments, null, 2),
    ].join("\n\n"),
  });

  for (const clip of reponse.clips ?? []) {
    const sujet = M.creerSujet(page, clip.titre, {
      clip: {
        source: path.basename(dossierSource),
        coupes: clip.coupes,
        accroche: clip.accroche,
        cadrage: clip.cadrage ?? "visage",
        pourquoi: clip.pourquoi ?? null,
        etat: "attente",
      },
    });
    M.toucher("sujet", sujet);
  }
}

/**
 * À brancher dans `reagirSujet` : un sujet qui porte `clip` ne passe ni par
 * ElevenLabs ni par Gemini. Sa voix et son minutage sont découpés dans la
 * source ; sa miniature est une image de la vidéo.
 */
export function estUnClip(sujet) {
  return Boolean(sujet.clip);
}

/** Prépare le sujet avant la File du PC : audio, minutage, vidéo coupée. */
export async function preparerClip(sujet, page) {
  const dossierSujet = path.join("Pages", page.dossier, "Sujets", sujet.dossier);
  await exec("node", [`${OUTILS}/clip-couper.mjs`, dossierSujet], { maxBuffer: 1 << 26 });
  sujet.clip.etat = "fait";
  M.toucher("sujet", sujet);
}
