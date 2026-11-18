# Portage du clipping vers TheGlobalFarm

Ce dossier contient le noyau de l'atelier de clipping, converti au stack de
TheGlobalFarm : des modules `.mjs` sans aucune dépendance, des outils en
ligne de commande qui prennent un chemin et écrivent un fichier, et rien
qui ressemble à une base de données ou à un framework.

Il n'est pas écrit à la main : `scripts/porter.sh` le reconstruit depuis les
sources de l'atelier. **Ne pas modifier ces fichiers directement** — la
modification se fait dans le code d'origine, puis on relance le portage.

## Ce qui est garanti

Quinze comparaisons entre l'original et le portage, sur les mêmes entrées :
détection des moments sous trois réglages, lexiques, accroches de cinq
moments, barème d'une accroche, remappage des sous-titres sur un montage à
trois coupes, fichier ASS complet. **Sorties identiques, zéro divergence.**
La commande : `npx tsx scripts/equivalence-portage.mjs`.

Les règles de TheGlobalFarm sont respectées : quatre cœurs au plus et jamais
la carte graphique, aucun paquet, aucun appel réseau dans le noyau, messages
en français sans abréviation.

## Où déposer chaque fichier

| Fichier | Destination |
|---|---|
| `Outils/clip.mjs` | `Montage/Outils/clip.mjs` |
| `Outils/moments.mjs`, `lexique.mjs`, `accroches.mjs` | `Montage/Outils/` |
| `Outils/sous-titres.mjs`, `clip-rendre.mjs`, `commun.mjs` | `Montage/Outils/` |
| `Outils/suivi-visage.mjs` + `suivi_visage.py` | `Montage/Outils/` |
| `Outils/source.py` | `Montage/Outils/` |
| `Outils/transcrire_local.py` | **à ne pas déposer** — Whisper est déjà là, avec la darija |
| `Interface/serveur/clips.mjs` | `Interface/serveur/clips.mjs` |

## Les trois verbes

```
node Montage/Outils/clip.mjs moments <minutage.json> [--min 18] [--max 60] [--nombre 6]
node Montage/Outils/clip.mjs planche <sujet>
node Montage/Outils/clip.mjs rendre  <sujet> [--cadrage visage]
```

`moments` lit le `_Minutage.json` du projet — `mots` et `lignes`, le contrat
central — et sort les passages notés avec leurs critères et leurs accroches
candidates. C'est ce qu'on donne à Claude pour qu'il décide du montage.

`planche` extrait une image par coupe. Pour un clip, **une coupe est une
scène** : la planche se juge comme celle d'un style animé, et Ayoub voit son
montage avant qu'une seule image soit rendue.

`rendre` exécute le montage : découpe, recollage dans l'ordre, cadrage
vertical, sous-titres incrustés, son normalisé.

## La correction à faire avant de coder

Le champ proposé dans le document de passation ne sait exprimer qu'une
tranche continue :

```jsonc
"clip": { "source": "…", "debut": 734.20, "fin": 781.90 }
```

Un montage qui a de la valeur retire une digression au milieu. Il faut des
coupes, au pluriel :

```jsonc
"clip": {
  "source": "NN_Nom_Source",
  "coupes": [
    { "debut": 734.20, "fin": 761.00, "note": "l'aveu et sa mise en place" },
    { "debut": 765.50, "fin": 781.90, "note": "on saute la relance", "zoom": 1.08 }
  ],
  "accroche": "…", "cadrage": "visage", "etat": "attente"
}
```

Deux conséquences techniques, apprises en les corrigeant :

1. **Les sous-titres doivent être reprojetés.** Un mot prononcé à 2:31 dans
   la source, gardé dans la deuxième coupe, s'affiche à 0:12 dans le clip.
   Sans ce remappage, ils défilent sur les mauvaises images dès qu'il y a
   plus d'une coupe. C'est `sous-titres.mjs`, et c'est testé.
2. **Le recollage refuse des rapports de pixel différents.** Un zoom sur une
   seule coupe modifie le rapport et le filtre de concaténation s'arrête
   net. `clip-rendre.mjs` normalise avant de recoller.

## Le branchement dans le moteur

Un clip fournit un `.mp3`, un `_Minutage.json` et une vidéo coupée : il
entre dans la File du PC comme n'importe quel sujet. Une seule bifurcation
est nécessaire, dans `moteur.mjs` :

```js
// Un sujet qui porte des coupes se rend par clip.mjs, pas par rendre.mjs :
// sa matière est une vraie vidéo, pas une composition HTML.
const outil = sujet.clip ? "Montage/Outils/clip.mjs" : "Montage/Outils/rendre.mjs";
const args  = sujet.clip ? ["rendre", dossierSujet] : [dossierSujet];
```

Et deux gardes dans `reagirSujet` : pas d'ElevenLabs et pas de miniature
Gemini pour un sujet qui porte `clip`. Sa voix est celle de la source, sa
miniature est une image de la vidéo. Sans ces gardes, on paie une voix
inutile à chaque clip.

Enfin, une ligne dans `GENRES` de `taches.mjs` pour que l'écran Activité
compte les clips.

## Un client est une page

Si le clipping sert des clients payants, il n'y a pas de modèle à inventer :
`_page.json` porte déjà le brief, les réseaux, la marque Metricool et le
dossier Drive, et l'accès par code PIN par page donne au client une vue sur
son travail et rien d'autre. Une page par client, et le circuit existant
fait le reste.

Ce qui manquerait alors dans `tgf` : le montant de l'abonnement, le nombre
de clips par mois et le nombre livré. Trois champs.

## Ce qui n'est pas porté, et pourquoi

- **La transcription.** Whisper est déjà installé dans le projet, avec
  l'amorce qui tient la darija. Le nôtre n'a pas de réponse à ce problème :
  c'est le vôtre qui gagne.
- **Metricool et le dépôt Drive.** Déjà en service, avec la normalisation du
  média sans laquelle Instagram publie une image à la place de la vidéo.
- **La qualification client.** Sans objet tant que la ferme produit pour
  elle-même.
- **Le serveur MCP.** Contraire au modèle : ici c'est le serveur qui appelle
  Claude et garde la main, ce qui tient mieux la règle « rien ne part sans
  validation ».

## Ce qui reste à décider

1. **Le suivi de visage entre-t-il ?** C'est le seul morceau qui demande un
   vrai travail d'intégration — OpenCV et un modèle de 10 Mo dans le projet.
   C'est aussi ce qui change le plus la qualité d'un clip tiré d'un plateau
   filmé en 16:9. Mesuré : un visage qui traverse l'image de 25 % à 77 % de
   la largeur est **complètement perdu** par un cadre fixe au centre ; le
   suivi le garde entre 49 % et 62 %.
2. **Où vit la source ?** `Pages/<Page>/Sources/` est proposé. Si plusieurs
   pages clippent la même matière, `Ferme/Sources/` serait plus juste.
3. **La transcription d'une source longue passe-t-elle par la File du PC ?**
   Oui, et c'est chiffré : 99 secondes d'audio en 21 secondes de processeur
   avec le plus petit modèle. Sur une source d'une heure avec un modèle
   utilisable, comptez quinze à vingt-cinq minutes.

## Ce qui n'a jamais été vérifié

Le noyau n'a tourné que sur des transcriptions simulées et 99 secondes de
parole réelle. **La qualité du repérage sur un vrai épisode n'est pas
mesurée.** C'est la première chose à faire avant d'en dépendre.
