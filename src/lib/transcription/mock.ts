/**
 * Transcription mock — un faux podcast français crédible.
 *
 * Le texte est volontairement inégal : des passages plats, des passages
 * forts (chiffres, questions, retournements, émotion). C'est ce qui permet
 * de vérifier que la détection de moments trie vraiment, au lieu de
 * renvoyer un score uniforme.
 */
import type { Segment, TranscriptionProvider, TranscriptionResult } from "./types";

const SCRIPT: Array<{ text: string; speaker: string; dur: number }> = [
  { text: "Bienvenue dans l'épisode, aujourd'hui on parle d'un sujet qui revient tout le temps dans mes messages.", speaker: "Hôte", dur: 5.5 },
  { text: "Avant de commencer, merci à tous ceux qui ont partagé le dernier épisode, ça aide beaucoup.", speaker: "Hôte", dur: 4.8 },
  { text: "Donc voilà, on va structurer ça en trois parties, assez classiquement.", speaker: "Hôte", dur: 3.9 },
  { text: "Alors, première question : pourquoi est-ce que 90 % des gens qui se lancent abandonnent en moins de six mois ?", speaker: "Hôte", dur: 6.2 },
  { text: "Franchement, j'ai mis sept ans à comprendre que je travaillais sur le mauvais problème.", speaker: "Invité", dur: 5.1 },
  { text: "Sept ans. À optimiser un truc que personne ne voulait acheter.", speaker: "Invité", dur: 4.0 },
  { text: "Et le jour où j'ai arrêté, j'ai fait plus de chiffre en trois mois qu'en quatre ans.", speaker: "Invité", dur: 5.4 },
  { text: "Ouais, enfin, il y avait aussi un contexte particulier à ce moment-là, le marché était porteur.", speaker: "Hôte", dur: 5.0 },
  { text: "Oui, bien sûr, on peut nuancer, mais le fond reste vrai.", speaker: "Invité", dur: 3.4 },
  { text: "On va passer sur les détails techniques, c'est un peu long à expliquer.", speaker: "Hôte", dur: 4.1 },
  { text: "Ce que personne ne te dit, c'est que la discipline, ça ne sert à rien sans un système derrière.", speaker: "Invité", dur: 5.8 },
  { text: "La motivation, c'est une émotion. Tu ne construis pas une entreprise sur une émotion.", speaker: "Invité", dur: 5.2 },
  { text: "Tu construis sur des contraintes. Tu réduis tes options jusqu'à ce qu'il n'en reste qu'une.", speaker: "Invité", dur: 5.6 },
  { text: "D'accord. Et concrètement, tu fais comment le lundi matin ?", speaker: "Hôte", dur: 3.7 },
  { text: "Je supprime. Chaque lundi, je supprime une tâche de ma liste sans la remplacer.", speaker: "Invité", dur: 5.3 },
  { text: "Au début c'est terrifiant, parce que tu as l'impression de reculer.", speaker: "Invité", dur: 4.4 },
  { text: "Hum, hum. Ouais.", speaker: "Hôte", dur: 1.6 },
  { text: "Bref, on continue. Il y a un autre point que je voulais aborder.", speaker: "Hôte", dur: 3.8 },
  { text: "Le truc le plus cher que j'ai payé dans ma vie, ce n'est pas un investissement raté.", speaker: "Invité", dur: 5.2 },
  { text: "C'est les deux ans où j'ai eu peur de demander de l'aide.", speaker: "Invité", dur: 4.3 },
  { text: "Deux ans à faire semblant que tout allait bien alors que je dormais quatre heures par nuit.", speaker: "Invité", dur: 5.9 },
  { text: "Et ma femme me l'a dit un soir : tu n'es plus là, même quand tu es là.", speaker: "Invité", dur: 5.5 },
  { text: "Ça, ça m'a réveillé plus que n'importe quel livre de développement personnel.", speaker: "Invité", dur: 5.0 },
  { text: "Oui, on entend souvent ce genre de témoignage, c'est important de le dire.", speaker: "Hôte", dur: 4.6 },
  { text: "Alors, on va regarder les chiffres maintenant, j'ai préparé quelques statistiques.", speaker: "Hôte", dur: 4.9 },
  { text: "En 2025, 68 % des créateurs qui publiaient trois fois par semaine ont doublé leur audience.", speaker: "Hôte", dur: 6.4 },
  { text: "Ceux qui publiaient une fois par semaine : 11 %. Le même contenu, la même qualité.", speaker: "Hôte", dur: 5.7 },
  { text: "Donc la fréquence bat la perfection, six fois sur dix.", speaker: "Invité", dur: 4.1 },
  { text: "Exactement. Et c'est contre-intuitif parce qu'on nous a appris l'inverse.", speaker: "Hôte", dur: 4.8 },
  { text: "Enfin bon, voilà. On fait une petite pause et on revient.", speaker: "Hôte", dur: 3.2 },
  { text: "Alors, dernière partie, celle que j'attendais.", speaker: "Hôte", dur: 2.9 },
  { text: "Si tu devais recommencer demain avec zéro euro, qu'est-ce que tu ferais exactement ?", speaker: "Hôte", dur: 5.3 },
  { text: "Je passerais trente jours à parler à des gens, sans rien vendre. Rien construire, juste écouter.", speaker: "Invité", dur: 6.1 },
  { text: "Parce que la vraie rareté aujourd'hui, ce n'est pas l'argent ni le talent.", speaker: "Invité", dur: 4.7 },
  { text: "C'est de savoir exactement quel problème tu résous, pour qui, et pourquoi maintenant.", speaker: "Invité", dur: 5.8 },
  { text: "Celui qui sait ça gagne, même avec un mauvais produit.", speaker: "Invité", dur: 4.0 },
  { text: "C'est une bonne conclusion, merci beaucoup pour ta franchise.", speaker: "Hôte", dur: 3.9 },
  { text: "Merci à toi, c'était un plaisir.", speaker: "Invité", dur: 2.4 },
  { text: "Pensez à vous abonner, à bientôt pour le prochain épisode.", speaker: "Hôte", dur: 4.0 },
];

/** Découpe une phrase en mots horodatés (pour les sous-titres karaoké). */
function wordsFor(text: string, start: number, end: number) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const span = (end - start) / Math.max(1, tokens.length);
  return tokens.map((t, i) => ({
    text: t,
    start: Number((start + i * span).toFixed(2)),
    end: Number((start + (i + 1) * span).toFixed(2)),
    confidence: 0.92,
  }));
}

export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = "mock";

  async transcribe(_source: string, opts?: { durationSec?: number }): Promise<TranscriptionResult> {
    const segments: Segment[] = [];
    let t = 1.5; // petit silence d'amorce
    const target = opts?.durationSec;

    let i = 0;
    while (true) {
      const line = SCRIPT[i % SCRIPT.length];
      const start = t;
      const end = Number((t + line.dur).toFixed(2));
      segments.push({
        idx: segments.length,
        startSec: Number(start.toFixed(2)),
        endSec: end,
        text: line.text,
        speaker: line.speaker,
        confidence: 0.94,
        words: wordsFor(line.text, start, end),
      });
      // Respiration variable entre les phrases : alimente le critère de rythme.
      t = end + (i % 4 === 0 ? 0.9 : i % 3 === 0 ? 0.35 : 0.12);
      i += 1;
      if (!target && i >= SCRIPT.length) break;
      if (target && t >= target - 1) break;
      if (i > 400) break; // garde-fou
    }

    return {
      provider: this.name,
      language: "fr",
      durationSec: target ?? Number(t.toFixed(2)),
      segments,
    };
  }
}
