import { generateTestRush, renderMultiCut, probeMedia } from "../src/lib/render/ffmpeg";
import { remapSegmentsForCuts } from "../src/lib/render/ass";
import { MockTranscriptionProvider } from "../src/lib/transcription/mock";

async function main() {
  const dir = "/tmp/clipflow-multicut";
  const probe = await generateTestRush(`${dir}/rush.mp4`, 220);
  const tr = await new MockTranscriptionProvider().transcribe("x", { durationSec: probe.durationSec });

  // Trois passages non contigus, dont un pris AVANT un autre dans le rush
  // mais remonté en tête du montage : on vérifie que l'ordre du plan prime.
  const cuts = [
    { start: 95.0, end: 112.0, note: "le chiffre" },
    { start: 30.0, end: 44.0, note: "la mise en place, remontée après", zoom: 1.1 },
    { start: 150.0, end: 163.0, note: "la chute" },
  ];
  const expected = cuts.reduce((s, c) => s + (c.end - c.start), 0);

  const remapped = remapSegmentsForCuts(tr.segments, cuts);
  console.log(`segments rush : ${tr.segments.length} → segments montés : ${remapped.length}`);
  console.log("premiers sous-titres montés :");
  for (const s of remapped.slice(0, 3)) {
    console.log(`  [${s.startSec.toFixed(1)}→${s.endSec.toFixed(1)}] ${s.text.slice(0, 58)}`);
  }
  const last = remapped[remapped.length - 1];
  console.log(`  …dernier : [${last.startSec.toFixed(1)}→${last.endSec.toFixed(1)}]`);

  const monotone = remapped.every((s, i) => i === 0 || s.startSec >= remapped[i - 1].startSec - 0.001);
  const withinClip = last.endSec <= expected + 0.05;
  console.log(`timeline croissante : ${monotone} · tient dans le clip : ${withinClip}`);

  const res = await renderMultiCut({
    source: `${dir}/rush.mp4`,
    outputPath: `${dir}/clip.mp4`,
    cuts,
    segments: tr.segments,
    hook: "68 % ont doublé leur audience",
    framing: "fit-blur",
    hasAudio: probe.hasAudio,
  });

  const out = await probeMedia(res.outputPath);
  console.log(`\nattendu ${expected.toFixed(2)} s · rendu ${out.durationSec.toFixed(2)} s · ${out.width}×${out.height}`);
  console.log(`écart : ${Math.abs(out.durationSec - expected).toFixed(3)} s`);
  console.log(`taille : ${(res.sizeBytes / 1e6).toFixed(1)} Mo · audio : ${out.hasAudio}`);
}

main();
