# ClipFlow — mon atelier de clipping

Je vends du clipping sur Whop. Les clients paient, je récupère ou je vais
chercher leur matière, **je monte avec Claude**, et Metricool publie.

```
① Whop            ② Rush             ③ Montage            ④ Validation   ⑤ Remise
   les clients   →   transcription  →   Claude décide,  →   ma relecture → dossier Drive
   qui paient        moments scorés     FFmpeg exécute                     ou Metricool
```

La plateforme ne décide pas du montage. Elle prépare tout ce qu'il faut pour
décider (transcription horodatée, moments scorés, hooks candidats), puis
**exécute le plan que Claude rend**. La décision éditoriale reste dans la
conversation ; l'exécution est automatique.

**Claude Desktop est branché directement dessus** par un serveur MCP : il lit
le travail du jour, ouvre les rushes, pose ses montages et dépose les clips
finis dans le dossier Drive. Rien à copier-coller.

---

## Démarrage

```bash
npm install
cp .env.example .env          # CLIPFLOW_MOCK=1 : tout tourne sans clé
npm run db:push
npm run db:seed               # atelier déjà en activité, rush de test inclus
npm run dev                   # http://localhost:3000
```

Prérequis : Node 22+, PostgreSQL 16+, **ffmpeg et ffprobe** dans le `PATH`.

```bash
npm test          # 49 tests : qualification, plans, remappage, Metricool…
npm run typecheck
npm run build
```

---

## Brancher Claude Desktop (serveur MCP)

C'est le chemin principal. Claude parle à l'atelier, il ne reçoit plus un
brief collé à la main.

1. Laisser l'atelier tourner : `npm run dev`.
2. Claude Desktop → **Réglages** → **Développeur** → **Modifier la
   configuration**, ce qui ouvre `claude_desktop_config.json`.
3. Y coller (la page **Réglages** de l'atelier affiche ce bloc avec le bon
   chemin absolu et un bouton pour le copier) :

```json
{
  "mcpServers": {
    "clipflow": {
      "command": "node",
      "args": ["/chemin/absolu/vers/clipflow/mcp/clipflow-server.mjs"],
      "env": { "CLIPFLOW_URL": "http://localhost:3000" }
    }
  }
}
```

4. Redémarrer Claude Desktop. Dans une conversation : « qu'est-ce que j'ai à
   monter aujourd'hui ? », ou la commande `/monter`.

**Les douze outils exposés**

| Outil | Ce qu'il fait |
|---|---|
| `whats_next` | le travail du jour, classé par urgence client |
| `get_rush` | un rush : brief client, moments scorés, hooks candidats |
| `get_transcript` | la transcription, fenêtrable sur un rush long |
| `get_brief` | le document complet en Markdown |
| `submit_edit_plan` | poser un ou plusieurs montages, et lancer le rendu |
| `render_plan` | relancer un rendu |
| `list_clips` · `get_clip` | ce qui est produit, avec la QA |
| `review_clip` | valider — ce qui déclenche la remise |
| `deliver_clip` · `delivery_status` | déposer dans le Drive, vérifier le dossier |
| `schedule_clip` | mettre en file Metricool |

Le serveur ne touche pas la base : il appelle l'atelier en HTTP, donc une
seule source de vérité et rien de plus à lancer. Si l'atelier est éteint,
Claude reçoit un message qui le dit.

Pour exposer l'API sur autre chose que la machine locale, renseigner
`CLIPFLOW_API_TOKEN` des deux côtés : les écritures l'exigeront.

## ⑤ La remise : le dossier Drive

Un clip validé est déposé dans `CLIPFLOW_DELIVERY_DIR`, rangé
`<client>/<AAAA-MM-JJ>/<titre>.mp4`, accompagné de :

- la vignette (`.jpg`), pour le repérer dans Drive ;
- une fiche lisible (`.txt`) : hook, légende, hashtags, réseaux, le détail
  des coupes et l'intention du montage ;
- une fiche complète (`.json`) pour tout outil qui automatiserait la suite.

Le dossier étant synchronisé par Drive, le fichier part en ligne sans que la
plateforme connaisse la moindre API de stockage. Si le dossier n'est pas
monté, le message le dit explicitement plutôt que d'échouer en silence, et la
validation du clip n'est pas annulée pour autant.

Metricool reste disponible en parallèle (`schedule_clip`), pour qui veut la
publication programmée plutôt que la remise par dossier.

## ③ Le montage avec Claude

Boucle manuelle, toujours disponible si Claude Desktop n'est pas branché.
Page `/rushes/<id>/montage` :

**1. Copier le brief.** Un document autonome (~15 k caractères pour un rush de
4 minutes) qui contient le brief du client, ses consignes de hook, ce qu'il
veut éviter, la durée de clip attendue, la transcription horodatée seconde par
seconde, les moments repérés avec le détail de leur score, les hooks
candidats, et le format JSON exact de la réponse attendue.

Les moments repérés sont donnés comme **indices, pas comme consignes** : le
brief dit explicitement à Claude qu'il peut couper ailleurs, recoller deux
passages distants, ou ignorer un moment bien noté s'il ne tient pas.

**2. Coller la réponse.** Le parseur est tolérant sur la forme et strict sur le
fond :

- le JSON est extrait même entouré de prose ou de blocs ```` ```json ````
- `1:31.5` est accepté là où le brief demandait `91.5`
- un plan unique sans tableau `clips` passe aussi
- les coupes sont vérifiées contre le rush : une fin au-delà de la durée est
  tronquée (avertissement), une coupe inversée est refusée (erreur)
- **les bornes sont recalées sur la parole** (±0,35 s) pour ne pas couper au
  milieu d'un mot, et le recalage est affiché
- durée hors bornes, chevauchement de coupes, hook de plus de 58 caractères :
  avertissements visibles, le rendu reste possible

**3. Le rendu.** FFmpeg exécute le plan en une passe : découpe de chaque coupe,
recollage **dans l'ordre donné par le plan** (deux passages peuvent être
inversés si le montage le demande), passage en 1080×1920, zoom facultatif par
coupe, sous-titres incrustés, hook en overlay, audio normalisé à −14 LUFS.

### Le recadrage qui suit les visages

`"framing": "face"` : le cadre vertical suit l'orateur au lieu de rester figé
au centre. Sur une source 16:9, c'est la différence entre un clip regardable
et un clip où la personne sort du champ dès qu'elle bouge.

Comment : un script Python (OpenCV, détecteur DNN res10) échantillonne la
coupe à 5 images par seconde, choisit le visage dominant — ou cadre le groupe
quand tous les visages tiennent dans la fenêtre — lisse la trajectoire avec
une zone morte contre le tremblement et un rattrapage adaptatif contre le
retard, puis FFmpeg applique les positions avec `sendcmd`.

Installation (facultative) :

```bash
./scripts/setup-face-tracking.sh
```

Sans ces dépendances, le rendu retombe sur le recadrage centré et le dit dans
le journal : la plateforme fonctionne sans.

Deux pièges rencontrés, pour qui toucherait au graphe FFmpeg : une commande
`sendcmd` doit viser `crop@étiquette` (l'étiquette nue est ignorée en
silence), et chaque commande veut un intervalle `début-fin [enter]`, pas un
instant sec. Deux tests gardent ces deux points.

Le point technique qui compte : **les sous-titres sont reprojetés sur la
timeline montée**. Un mot prononcé à 2:31 dans le rush et gardé dans la
deuxième coupe s'affiche à 0:12 dans le clip. Sans ce remappage, les
sous-titres défileraient sur les mauvaises images dès qu'il y a plus d'une
coupe.

### Le format du plan

```json
{
  "version": "clipflow-plan-1",
  "clips": [{
    "title": "Sept ans sur le mauvais problème",
    "hook": "7 ans perdus sur le mauvais problème",
    "caption": "La légende du post",
    "hashtags": ["business"],
    "cuts": [
      { "start": 53.1, "end": 80.1, "note": "l'aveu et sa mise en place" },
      { "start": 84.5, "end": 107.2, "note": "on saute la relance de l'hôte", "zoom": 1.08 }
    ],
    "framing": "fit-blur",
    "burnSubtitles": true,
    "captionOverrides": [],
    "rationale": "Pourquoi ce montage tient."
  }]
}
```

### Sans passer par l'interface

Claude Code — ou n'importe quel script — peut travailler directement :

```bash
curl -s localhost:3000/api/rushes/<id>/brief > brief.md     # récupérer le brief
curl -X POST localhost:3000/api/edit-plans \                # déposer le plan
     -H 'content-type: application/json' \
     -d '{"rushId":"<id>","plan":{…},"render":true}'
```

La réponse donne les plans enregistrés, les avertissements, et l'identifiant
des clips rendus.

---

## ① Whop — les clients qui paient

Les abonnements arrivent par webhook signé (Standard Webhooks : HMAC-SHA256
sur le corps brut, tolérance 5 minutes, déduplication sur `webhook-id`) ou par
synchronisation manuelle. Le schéma de payload n'étant pas intégralement
publié, le normaliseur accepte plusieurs variantes de nommage.

**La qualification répond à une seule question : ce client vaut-il mon temps ?**
Sur 100 : valeur de l'abonnement 25 · matière disponible 20 · **prix par clip
15** · potentiel de diffusion 15 · clarté du brief 15 · paiement 10.

Le prix par clip a un droit de veto : en dessous de 15 € le clip, le dossier
est refusé quel que soit son score. C'est le piège du volume — un client à
390 €/mois pour 40 clips affiche 74/100 sur le papier et reste une mauvaise
affaire à 9,75 € le clip.

Un abonnement impayé ne bloque pas la qualification mais ouvre le résumé :
« ne rien produire tant que le paiement n'est pas régularisé ».

**La priorité de production** est un second score, distinct : un retard
d'échéance vaut 60 points et passe donc devant le cumul de tous les autres
critères (55 au maximum). Une promesse rompue coûte plus cher qu'un gros
client servi un jour plus tard.

## ② Le rush

Déposé par le client ou sourcé par moi (la distinction est tracée et pèse dans
la qualification). Sonde `ffprobe`, puis transcription derrière une interface
unique — OpenAI Whisper, Deepgram, `whisper` local, ou mock — avec horodatage
**au mot**, ce qui permet les sous-titres en groupes de 3–4 mots.

La détection de moments note des fenêtres glissantes sur 8 critères (ouverture
accrocheuse 18, charge émotionnelle 16, faits et chiffres 14, retournement 12,
compréhensible seul 12, débit utile 12, durée 8, rythme 8), pénalise les
passages logistiques et le remplissage oral, puis écarte les moments qui se
recouvrent à plus de 35 %. Les hooks candidats sont notés sur brièveté,
spécificité, tension, ouverture, lisibilité et **fidélité au contenu**.

Tout ça n'existe que pour nourrir le brief.

## ④ Ma validation · ⑤ Metricool

Un clip validé compte dans le quota mensuel du client et devient publiable.

Publication : `POST /v2/scheduler/posts`, en-tête `X-Mc-Auth`, `userId` et
`blogId` en query string, date **locale sans décalage** + fuseau IANA. Une date
passée est repoussée de 5 minutes plutôt que de provoquer un 400. La file
distingue les erreurs récupérables (réseau, 429, 5xx → rejouées, 4 tentatives)
des refus définitifs (400, 401, 403 → arrêtés).

> Divergence documentaire assumée : le guide Metricool décrit `media` comme un
> objet `{ mediaId }`, la page White Label comme un tableau de chaînes. Le
> format est un réglage (`mediaMode`, défaut `array`), pas une supposition.

---

## Mode mock

Sans clé, chaque intégration tourne en mock et le flux complet s'exécute sans
aucun appel réseau. Une clé renseignée bascule l'étage en réel, sans
modification de code. L'état de chaque étage est visible dans **Réglages**.

| Étage | Variables | Sans clé |
|---|---|---|
| ① Whop API | `WHOP_API_KEY` | 6 clients fictifs contrastés |
| ① Webhook | `WHOP_WEBHOOK_SECRET` | l'endpoint refuse tout (503) |
| ① OAuth | `WHOP_OAUTH_CLIENT_ID/SECRET` | profil de démonstration |
| ② Transcription | `TRANSCRIPTION_PROVIDER` + clé | faux podcast français horodaté |
| ② Hooks candidats | `ANTHROPIC_API_KEY` | générateur heuristique |
| ⑤ Metricool | `METRICOOL_USER_TOKEN`, `_USER_ID`, `_BLOG_ID` | posts en mémoire |

`ANTHROPIC_API_KEY` ne sert qu'à enrichir les **hooks candidats** du brief.
Le montage, lui, se fait dans le chat : la plateforme n'appelle aucune API
pour ça.

---

## Interfaces

| Page | Rôle |
|---|---|
| `/` | le flux en cinq étages, revenu, quotas, journal |
| `/clients` | abonnements Whop qualifiés, brief éditable par client |
| `/rushes` · `/rushes/[id]` | import, carte des moments, transcription, hooks |
| `/rushes/[id]/montage` | **brief → Claude → plan → rendu** |
| `/montage` | ma file de travail, classée par urgence client |
| `/review` | ma relecture avant mise en ligne |
| `/publishing` | calendrier 7 jours et file Metricool |
| `/settings` | état des intégrations, URL du webhook |

## API

| Route | Usage |
|---|---|
| `GET /api/rushes/[id]/brief` | le brief (`?format=json`, `?clips=3`, `?transcript=around-moments`) |
| `POST /api/edit-plans` | déposer un plan, avec `render: true` pour enchaîner |
| `GET /api/edit-plans?rushId=` | les plans d'un rush |
| `POST /api/pipeline` | préparer un rush jusqu'au brief |
| `POST /api/whop/webhook` | abonnements signés |
| `GET /api/cron/publish` | traiter la file de publication |
| `GET /api/media/...` | rushes et clips, requêtes `Range` gérées |

---

## Les outils open source du même domaine

Vérifié repo par repo, fichier `LICENSE` à l'appui, avant de reprendre quoi
que ce soit. Les licences ne sont pas celles qu'on lit dans les comparatifs.

| Projet | Licence réelle | Utilisable dans une activité payante ? |
|---|---|---|
| `mutonby/openshorts` | MIT (le dossier `cloud/` a sa propre licence commerciale) | oui, en gardant la mention de licence |
| `JeremySNR/cutawan` | MIT | oui, en gardant la mention de licence |
| `FujiwaraChoki/supoclip` | **SupoClip Noncommercial Source License** — pas AGPL | **non** sans accord écrit, usage interne compris |
| `ColinGPT9/clips-studio` | AGPL-3.0 | seulement en publiant tout le code de la plateforme |

Deux corrections par rapport à ce qui circule : SupoClip n'est pas sous
AGPL mais sous une licence « source disponible » qui interdit l'usage
commercial, ce qui est **plus** restrictif ; et c'est Clips Kitty qui est en
AGPL-3.0.

Ce qui a été repris : **rien**, au sens du code. Le seul élément qui manquait
vraiment — le recadrage qui suit l'orateur — a été écrit ici (OpenCV +
`sendcmd`), ce qui évite d'embarquer Docker, une dépendance Gemini ou un
projet Electron entier pour une fonction de 200 lignes. Les 12 styles de
sous-titres de Cutawan relèvent du même raisonnement : c'est de la feuille de
style ASS, pas de la technique.

Ce qui resterait à prendre ailleurs, si le besoin se présente : la détection
du **locuteur actif** (qui parle, pas seulement qui est à l'image). Cutawan
l'implémente avec un modèle LR-ASD en ONNX, sous MIT. C'est le seul morceau
qui demanderait un vrai travail d'intégration, et il n'a de sens que sur des
plateaux à plusieurs personnes.

## Limites connues

- **Stockage local.** Les médias vivent dans `./storage`. Metricool exige une
  URL publique non expirante : en production, pointez
  `CLIPFLOW_PUBLIC_BASE_URL` vers un domaine joignable ou passez sur S3/R2.
- **Pas d'authentification applicative.** L'OAuth Whop identifie et vérifie
  l'abonnement, mais l'interface n'est pas protégée : à faire avant de
  l'exposer.
- **Rendu synchrone.** FFmpeg tourne dans le processus web. Au-delà de
  quelques clips simultanés, il faut une file de travaux séparée.
- **Le brief grossit avec le rush.** 15 k caractères pour 4 minutes, donc
  environ 200 k pour une heure. Au-delà d'une vingtaine de minutes, utilisez
  `?transcript=around-moments` pour n'envoyer que les passages utiles.
- **Aucune récupération des vues.** Metricool ne documente pas d'endpoint
  d'analytics public ; les compteurs viennent du seed.
- **Chemins REST Whop.** La doc publique passe par le SDK sans donner tous les
  chemins HTTP ; ils sont centralisés dans `WHOP_PATHS` pour être corrigés en
  un seul endroit.
- **Le suivi de visage demande Python et OpenCV**, et ne sait pas qui parle :
  il suit le visage dominant. Sur un plateau à deux où l'un parle pendant que
  l'autre écoute, le cadre peut rester sur le mauvais. La vraie réponse est
  la détection de locuteur actif (audio + vidéo), qui n'est pas implémentée.
- **L'API locale est ouverte par défaut.** Tant que `CLIPFLOW_API_TOKEN` est
  vide, toute requête vers `localhost:3000` peut écrire. Acceptable sur un
  poste de travail, à ne pas exposer tel quel.
