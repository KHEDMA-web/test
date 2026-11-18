/**
 * Les quelques utilitaires dont le noyau a besoin, sans aucune dépendance.
 */
/** Borne une valeur entre deux limites. */
export function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}
/** Timecode lisible : 1:04.3 */
export function formatTimecode(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
