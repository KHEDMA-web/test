#!/usr/bin/env bash
# Reconstruit le portage vers le stack de TheGlobalFarm depuis les sources.
# À relancer chaque fois que le noyau évolue : le portage n'est jamais
# modifié à la main, il dérive toujours du code d'origine.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Préparation des sources"
rm -rf portage/_source portage/Outils
mkdir -p portage/_source portage/Outils

cat > portage/_source/commun.ts <<'TS'
/**
 * Les quelques utilitaires dont le noyau a besoin, sans aucune dépendance.
 */

/** Borne une valeur entre deux limites. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Timecode lisible : 1:04.3 */
export function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Un segment de transcription : le contrat d'entrée du noyau. */
export type Segment = {
  idx: number;
  startSec: number;
  endSec: number;
  text: string;
  speaker?: string;
  confidence?: number;
  words?: Array<{ text: string; start: number; end: number; confidence?: number }>;
};
TS

cp src/lib/pipeline/lexicon.ts portage/_source/lexique.ts
sed -e 's|from "\.\./utils"|from "./commun.js"|' \
    -e 's|from "\.\./transcription/types"|from "./commun.js"|' \
    -e 's|from "\./lexicon"|from "./lexique.js"|' \
    src/lib/pipeline/moments.ts > portage/_source/moments.ts
sed -e 's|from "\.\./transcription/types"|from "./commun.js"|' \
    src/lib/render/ass.ts > portage/_source/sous-titres.ts
cp src/lib/render/faceTrack.ts portage/_source/suivi-visage.ts
sed -e 's|from "\./ass"|from "./sous-titres.js"|' \
    -e 's|from "\./faceTrack"|from "./suivi-visage.js"|' \
    -e 's|from "\.\./transcription/types"|from "./commun.js"|' \
    src/lib/render/ffmpeg.ts > portage/_source/clip-rendre.ts

# Les accroches perdent leur passerelle vers l'API : chez Ayoub, c'est le
# serveur qui appelle Claude en ligne de commande.
python3 - <<'PY'
s = open("src/lib/pipeline/hooks.ts").read()
s = s[: s.index("const HOOK_SYSTEM_PROMPT")]
s = s.replace('import { config, live } from "../config";\n', "")
s = s.replace('import { clamp } from "../utils";', 'import { clamp } from "./commun.js";')
s = s.replace('from "./lexicon";', 'from "./lexique.js";')
s = s.replace('from "./moments";', 'from "./moments.js";')
s = s.rstrip() + """

/** Les meilleures accroches d'un moment, triées. */
export function genererAccroches(moment: DetectedMoment, limite = 6): HookCandidate[] {
  return generateHeuristicHooks(moment).slice(0, limite);
}
"""
open("portage/_source/accroches.ts", "w").write(s)
PY

cat > portage/_source/tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "removeComments": false, "declaration": false,
    "outDir": "../Outils", "skipLibCheck": true
  },
  "include": ["*.ts"]
}
JSON

echo "→ Compilation, commentaires conservés"
npx tsc -p portage/_source/tsconfig.json

echo "→ Extensions et spécificateurs"
cd portage/Outils
for f in *.js; do
  sed -e 's|\(from "\./[a-z-]*\)\.js"|\1.mjs"|g' "$f" > "${f%.js}.mjs"
  rm "$f"
done
cd ../..

echo "→ Scripts Python"
cp scripts/face_track.py portage/Outils/suivi_visage.py
cp scripts/resolve_source.py portage/Outils/source.py
cp scripts/transcribe_local.py portage/Outils/transcrire_local.py

echo "→ Vérification"
for f in portage/Outils/*.mjs; do node --check "$f"; done
rm -rf portage/_source
echo "Portage reconstruit : $(ls portage/Outils | wc -l) fichiers"
