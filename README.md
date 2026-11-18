# ClipFlow — du rush à la mise en ligne

Plateforme de clipping complète. Le flux suit l'ordre demandé :

```
① Whop            ② Rush              ③ Moments & hooks     ④ Montage           ⑤ Metricool
   recrutement   →   transcription   →   détection scorée  →   auto + clipper  →   publication
   des clippers      horodatée           + hooks notés          9:16, review        programmée
```

Chaque étage est autonome : on peut relancer la détection sans refaire la
transcription, remonter un clip sans retoucher le rush, rejouer une
publication sans reprendre le montage.

---

## Démarrage

```bash
npm install
cp .env.example .env          # CLIPFLOW_MOCK=1 par défaut : tout tourne sans clé
npm run db:push               # crée le schéma
npm run db:seed               # peuple une plateforme vivante (rush de test inclus)
npm run dev                   # http://localhost:3000
```

Prérequis : Node 22+, PostgreSQL 16+, **ffmpeg et ffprobe** dans le `PATH`
(le rendu des clips et la sonde des rushes en dépendent).

```bash
npm test          # 30 tests : scoring, signature webhook, ASS, payload Metricool
npm run typecheck
npm run build
```

---

## Mode mock et bascule en réel

Sans clé, chaque intégration tourne en mock : le flux complet
rush → publication s'exécute **sans aucun appel réseau**. Dès qu'une clé est
renseignée, l'étage correspondant passe en réel, sans modification de code —
le code appelant est strictement le même (`src/lib/config.ts` → `live.*`).

| Étage | Variables | Sans clé |
|---|---|---|
| ① Whop API | `WHOP_API_KEY` | 6 candidats fictifs scorés |
| ① Webhook | `WHOP_WEBHOOK_SECRET` | endpoint refuse tout (503) tant que la signature n'est pas vérifiable |
| ① OAuth | `WHOP_OAUTH_CLIENT_ID/SECRET` | profil de démonstration |
| ② Transcription | `TRANSCRIPTION_PROVIDER` + clé | faux podcast français horodaté |
| ③ Hooks | `HOOKS_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` | générateur heuristique |
| ⑤ Metricool | `METRICOOL_USER_TOKEN`, `_USER_ID`, `_BLOG_ID` | posts stockés en mémoire |

L'état réel de chaque étage est visible dans **Réglages**.

---

## Étage ① — Whop : trouver les bonnes personnes

**Entrées** : webhook signé (temps réel) ou synchronisation manuelle.

Le webhook suit la spécification **Standard Webhooks** telle que Whop
l'implémente : en-têtes `webhook-id` / `webhook-timestamp` /
`webhook-signature`, HMAC-SHA256 sur `{id}.{timestamp}.{corps brut}`, clé =
la chaîne `ws_...` complète. Le corps est vérifié **avant** tout parsing,
l'horodatage est rejeté au-delà de 5 minutes, et la livraison est
dédupliquée sur `webhook-id` (Whop livre *at-least-once*).

La doc publique de Whop se contredit sur les noms exacts des événements
`membership.*` : toute la famille est donc traitée de la même façon et
**l'état est recalculé depuis le payload**, jamais déduit du nom de
l'événement. Le schéma du payload n'étant pas publié intégralement, le
normaliseur accepte plusieurs variantes de nommage (`user_id` / `user`,
`product_id` / `access_pass`, epoch ou ISO).

**Scoring des candidatures** (`src/lib/whop/recruiting.ts`), sur 100 :
preuves de travail 25 · traction passée 25 · niche demandée 15 · audience 15 ·
outils 10 · membership valide 10. ≥ 70 → accès automatique, 45–69 →
décision humaine, < 45 → écarté.

**Scoring des clippers**, recalculé à chaque décision, uniquement sur des
résultats observés : taux de validation 30 · vues moyennes 30 ·
ponctualité 20 · volume 10 · activité récente 10. Sous 5 clips soumis, le
taux de validation est bridé : un 2/2 ne vaut pas un 40/40.

**Attribution** : adéquation clipper ↔ rush sur historique 40 · niche 25 ·
charge actuelle 20 · délai 10 · langue 5. Un clipper saturé sort du classement.

Aucun score n'est opaque : chaque critère expose sa valeur brute, ses points
et son maximum, affichés dans l'interface.

## Étage ② — Rush et transcription

Sonde `ffprobe` (durée, résolution, fps, piste audio), puis transcription
derrière une interface unique : OpenAI Whisper, Deepgram, `whisper` local,
ou mock. Les segments sont stockés avec horodatage **au mot**, ce qui permet
les sous-titres en groupes de 3–4 mots au montage.

## Étage ③ — Les meilleurs moments et les meilleurs hooks

`src/lib/pipeline/moments.ts` — fonction pure, testable, déterministe.
Fenêtres glissantes de segments consécutifs dans la fourchette de durée,
notées sur 8 critères (100 points) :

| Critère | Poids | Ce qu'il mesure |
|---|---|---|
| Ouverture accrocheuse | 18 | le clip tient-il debout dès la première seconde |
| Charge émotionnelle | 16 | lexique d'intensité, 6 familles |
| Faits et chiffres | 14 | nombres, pourcentages, durées |
| Retournement narratif | 12 | « sauf que », « ce que personne », « jusqu'au jour » |
| Compréhensible seul | 12 | début net, fin non tronquée, pas de pronom orphelin |
| Débit utile | 12 | mots/seconde vs ~2,8 idéal |
| Durée | 8 | zone 22–45 s |
| Rythme | 8 | blancs internes |

Pénalités : passage logistique (intro, remerciements, appel à l'abonnement),
remplissage oral. Puis suppression des chevauchements : deux moments qui
partagent plus de 35 % de leur durée se cannibaliseraient, seul le meilleur
est gardé.

**Hooks** : 7 angles (question, chiffre, contrarien, curiosity-gap,
confession, promesse, callout), remplis avec ce que le passage contient
réellement — groupes nominaux extraits par déterminant (sans étiqueteur
morphosyntaxique, c'est l'heuristique qui évite les formes verbales), et
seulement les vrais nombres. Chaque hook est noté sur 100 : brièveté 20 ·
spécificité 20 · tension 20 · ouverture 15 · lisibilité 15 · **fidélité au
contenu 10** — un hook inventé perd des points.

Avec `ANTHROPIC_API_KEY`, Claude réécrit les hooks (sortie structurée par
outil strict, `tool_choice` laissé en `auto` puisque le forcer renvoie un
400 sur les modèles courants). Ses propositions passent par **le même
scorer** : elles ne sont pas retenues d'office. Si l'appel échoue, le
pipeline continue sur l'heuristique.

## Étage ④ — Montage hybride

- **Brouillon automatique** : FFmpeg découpe le moment, passe en 1080×1920
  (recadrage centré, ou fond flou pour un rush paysage), incruste les
  sous-titres et le hook via un fichier ASS unique (libass gère retour à la
  ligne, contour et placement — plus fiable qu'une pile de `drawtext`),
  normalise l'audio à −14 LUFS.
- **Version du clipper** : le fichier déposé crée une **nouvelle révision**
  chaînée au brouillon, qui reste consultable comme référence.
- **Contrôle qualité automatique** avant review : format 9:16, durée dans
  les bornes de la campagne, hook lisible.
- **Review** : valider / demander des corrections / refuser. La décision
  met à jour le score du clipper, qui pilote les attributions suivantes.

## Étage ⑤ — Publication via Metricool

`POST https://app.metricool.com/api/v2/scheduler/posts?blogId=…&userId=…`,
jeton dans l'en-tête `X-Mc-Auth`. La date part en **heure locale sans
décalage** (`2026-08-01T10:00:00`) accompagnée du fuseau IANA, comme l'exige
l'API ; une date passée est automatiquement repoussée de 5 minutes plutôt
que de provoquer un 400.

Un clip validé produit une publication par réseau, décalées de quelques
minutes. La file distingue les erreurs **récupérables** (réseau, 429, 5xx →
rejouées, 4 tentatives) des **définitives** (400, 401, 403 → marquées en
échec sans boucler). Chaque code d'erreur est traduit en message
actionnable.

> Point de divergence documentaire assumé : le guide « Basic Guide for API
> Integration » décrit `media` comme un objet `{ mediaId }`, la page White
> Label comme un tableau de chaînes. Le format est donc un **réglage**
> (`mediaMode`, défaut `array`) plutôt qu'une supposition figée.

Traitement de la file : bouton dans l'interface, ou cron sur
`GET /api/cron/publish` (protégé par `CRON_SECRET` si défini).

---

## Interfaces

| Page | Rôle |
|---|---|
| `/` | entonnoir des 5 étages, journal du pipeline, état des intégrations |
| `/recruitment` | candidatures Whop scorées et dépliables, classement des clippers |
| `/campaigns` | brief, consignes de hook, réseaux, rémunération, budget |
| `/rushes` + `/rushes/[id]` | import, carte des moments sur la durée, transcription, hooks, attribution |
| `/studio` + `/studio/[id]` | lecteur 9:16, recette FFmpeg, révisions, dépôt de version, programmation |
| `/review` | file de validation |
| `/publishing` | calendrier 7 jours et file Metricool |
| `/settings` | état réel de chaque intégration, URL du webhook, derniers webhooks reçus |

## API

| Route | Usage |
|---|---|
| `POST /api/whop/webhook` | réception signée des memberships |
| `GET /api/whop/oauth/start` · `/callback` | « Se connecter avec Whop » (PKCE) |
| `POST /api/pipeline` | lance le flux complet sur un rush (`filePath` ou `sourceUrl`) |
| `GET /api/cron/publish` | traite la file de publication |
| `GET /api/media/...` | sert rushes et clips, requêtes `Range` gérées |

---

## Limites connues

- **Stockage local.** Les médias vivent dans `./storage`. Metricool exige
  une URL **publique et non expirante** : en production, pointez
  `CLIPFLOW_PUBLIC_BASE_URL` vers un domaine joignable, ou basculez le
  stockage vers S3/R2.
- **Pas d'authentification applicative.** L'OAuth Whop identifie et vérifie
  l'accès, mais il n'y a pas encore de session ni de cloisonnement par rôle
  dans l'UI : à ajouter avant une mise en ligne publique.
- **Rendu synchrone.** Les rendus FFmpeg tournent dans le processus web. Au
  delà de quelques clips simultanés, il faut une file de travaux séparée.
- **Chemins REST Whop.** La doc publique décrit les memberships via le SDK
  sans donner tous les chemins HTTP bruts ; ils sont centralisés dans
  `WHOP_PATHS` (`src/lib/whop/client.ts`) pour être corrigés en un seul
  endroit si la spec OpenAPI diffère.
- **Vues non synchronisées.** Les compteurs de vues sont alimentés par le
  seed ; aucun endpoint d'analytics Metricool n'est documenté publiquement,
  la récupération reste à brancher.
