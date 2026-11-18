/** Échappe le texte pour un champ ASS (une seule ligne par événement). */
function escapeAss(text) {
    return text
        .replace(/\\/g, "\\\\")
        .replace(/\{/g, "(")
        .replace(/\}/g, ")")
        .replace(/\r?\n/g, "\\N");
}
function assTime(seconds) {
    const s = Math.max(0, seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const cs = Math.floor((sec % 1) * 100);
    return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(sec)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
/** Découpe une phrase en groupes de 3-4 mots : lisible en vertical. */
export function chunkWords(words, perChunk = 4) {
    const chunks = [];
    for (let i = 0; i < words.length; i += perChunk) {
        const group = words.slice(i, i + perChunk);
        if (!group.length)
            continue;
        chunks.push({
            text: group.map((w) => w.text).join(" "),
            start: group[0].start,
            end: group[group.length - 1].end,
        });
    }
    return chunks;
}
export function buildAss(input) {
    const width = input.style?.width ?? 1080;
    const height = input.style?.height ?? 1920;
    const font = input.style?.fontName ?? "Inter";
    const duration = input.clipEndSec - input.clipStartSec;
    // Marges verticales : le hook en haut, les sous-titres au-dessus de la zone UI.
    const hookMarginV = Math.round(height * ((input.style?.hookTopPercent ?? 14) / 100));
    const captionMarginV = Math.round(height * ((input.style?.captionBottomPercent ?? 22) / 100));
    const header = `[Script Info]
; Généré par ClipFlow
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Hook,${font},${Math.round(height * 0.042)},&H00FFFFFF,&H000000FF,&H00101010,&H64000000,-1,0,0,0,100,100,0,0,1,6,2,8,80,80,${hookMarginV},1
Style: Caption,${font},${Math.round(height * 0.034)},&H00FFFFFF,&H000000FF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,5,1,2,90,90,${captionMarginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
    const events = [];
    // Le hook : affiché d'entrée, avec un léger fondu.
    if (input.hook && input.hook.trim()) {
        const hookEnd = Math.min(duration, input.hookDurationSec ?? 3.5);
        events.push(`Dialogue: 1,${assTime(0)},${assTime(hookEnd)},Hook,,0,0,0,,{\\fad(180,220)}${escapeAss(input.hook.trim())}`);
    }
    // Les sous-titres, rebasés sur le début du clip et coupés à ses bornes.
    for (const seg of input.segments) {
        if (seg.endSec <= input.clipStartSec || seg.startSec >= input.clipEndSec)
            continue;
        const words = (seg.words ?? []).filter((w) => w.end > input.clipStartSec && w.start < input.clipEndSec);
        if (words.length) {
            for (const chunk of chunkWords(words, 4)) {
                const start = Math.max(0, chunk.start - input.clipStartSec);
                const end = Math.min(duration, chunk.end - input.clipStartSec);
                if (end - start < 0.12)
                    continue;
                events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${escapeAss(chunk.text)}`);
            }
        }
        else {
            // Pas de mots horodatés : on affiche le segment entier.
            const start = Math.max(0, seg.startSec - input.clipStartSec);
            const end = Math.min(duration, seg.endSec - input.clipStartSec);
            if (end - start < 0.2)
                continue;
            events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${escapeAss(seg.text)}`);
        }
    }
    return header + events.join("\n") + "\n";
}
/**
 * Projette les segments du rush sur la timeline du clip monté.
 *
 * Un montage à plusieurs coupes recolle des morceaux non contigus : un mot
 * prononcé à 2:31 dans le rush peut se retrouver à 0:12 dans le clip. Sans
 * ce remappage, les sous-titres défileraient sur les mauvaises images.
 */
export function remapSegmentsForCuts(segments, cuts) {
    const out = [];
    let offset = 0;
    let idx = 0;
    for (const cut of cuts) {
        const cutDuration = cut.end - cut.start;
        for (const seg of segments) {
            if (seg.endSec <= cut.start || seg.startSec >= cut.end)
                continue;
            const start = Math.max(seg.startSec, cut.start) - cut.start + offset;
            const end = Math.min(seg.endSec, cut.end) - cut.start + offset;
            if (end - start < 0.08)
                continue;
            const words = (seg.words ?? [])
                .filter((w) => w.end > cut.start && w.start < cut.end)
                .map((w) => ({
                text: w.text,
                start: Math.max(w.start, cut.start) - cut.start + offset,
                end: Math.min(w.end, cut.end) - cut.start + offset,
                confidence: w.confidence,
            }))
                .filter((w) => w.end > w.start);
            out.push({
                idx: idx++,
                startSec: Number(start.toFixed(3)),
                endSec: Number(end.toFixed(3)),
                text: seg.text,
                speaker: seg.speaker,
                confidence: seg.confidence,
                words: words.length ? words : undefined,
            });
        }
        offset += cutDuration;
    }
    return out;
}
