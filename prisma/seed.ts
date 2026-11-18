/**
 * Seed : monte un atelier déjà en activité.
 *  1. Moi
 *  2. Les clients Whop, qualifiés
 *  3. Un rush du meilleur client, analysé jusqu'au brief
 *  4. Un montage tel que Claude le rendrait — plusieurs coupes — exécuté
 *  5. Validation et mise en file Metricool
 */
import { prisma } from "../src/lib/db";
import { syncAllMemberships } from "../src/lib/whop/sync";
import { prepareRush } from "../src/lib/pipeline/orchestrator";
import { createPlansFromInput } from "../src/lib/pipeline/editPlan";
import { renderPlan, reviewClip } from "../src/lib/pipeline/clips";
import { queueClipPublications, processQueue } from "../src/lib/metricool/publish";
import { generateTestRush } from "../src/lib/render/ffmpeg";
import { ensureStorage, storagePath } from "../src/lib/storage";
import { buildEditBrief } from "../src/lib/pipeline/brief";

async function main() {
  console.log("→ Nettoyage");
  await prisma.$transaction([
    prisma.pipelineEvent.deleteMany(),
    prisma.publication.deleteMany(),
    prisma.clipReview.deleteMany(),
    prisma.clip.deleteMany(),
    prisma.editPlan.deleteMany(),
    prisma.hook.deleteMany(),
    prisma.moment.deleteMany(),
    prisma.transcriptSegment.deleteMany(),
    prisma.rush.deleteMany(),
    prisma.client.deleteMany(),
    prisma.whopMembership.deleteMany(),
    prisma.user.deleteMany(),
    prisma.webhookEvent.deleteMany(),
    prisma.setting.deleteMany(),
  ]);

  console.log("→ Mon compte");
  const me = await prisma.user.create({
    data: { email: "moi@clipflow.local", name: "Moi (clippeur)", role: "OWNER" },
  });
  await prisma.setting.create({ data: { key: "my_niches", value: "business,podcast,mindset,tech" } });

  console.log("→ Synchro Whop : les clients qui paient");
  const sync = await syncAllMemberships();
  console.log(`   ${sync.total} abonnement(s) — ${sync.toTake} à prendre (mode ${sync.mode})`);

  const clients = await prisma.client.findMany({ orderBy: { score: "desc" } });
  for (const c of clients) {
    console.log(`   ${c.score.toString().padStart(3)} ${c.decision?.padEnd(9)} ${c.name} — ${(c.mrrCents / 100).toFixed(0)} €/mois, ${c.clipsPerMonth} clips`);
  }

  const top = clients.find((c) => c.decision === "prendre") ?? clients[0];
  // Quelques clips déjà livrés ce mois-ci, pour que les quotas vivent.
  await prisma.client.update({ where: { id: top.id }, data: { clipsDelivered: 6 } });

  console.log(`\n→ Rush de ${top.name}`);
  await ensureStorage();
  const rushPath = storagePath("rush", "demo-episode-12.mp4");
  await generateTestRush(rushPath, 240);

  const report = await prepareRush({
    title: "Épisode 12 — « La discipline ne suffit pas »",
    description: "Rush brut de l'épisode long.",
    clientId: top.id,
    uploaderId: me.id,
    filePath: rushPath,
    language: "fr",
    origin: "CLIENT_UPLOAD",
    clipsTarget: 2,
    dueAt: new Date(Date.now() + 36 * 3600_000),
  });
  for (const s of report.steps) console.log(`   ${s.ok ? "✓" : "✗"} ${s.stage} — ${s.detail}`);

  console.log("\n→ Montage (plan tel que Claude le rend, collé dans l'interface)");
  const segments = await prisma.transcriptSegment.findMany({
    where: { rushId: report.rushId },
    orderBy: { idx: "asc" },
  });
  const moments = await prisma.moment.findMany({
    where: { rushId: report.rushId },
    orderBy: { score: "desc" },
    take: 2,
    include: { hooks: { orderBy: { score: "desc" }, take: 1 } },
  });

  // Premier clip : le meilleur moment, dont on retire une relance au milieu —
  // exactement ce qu'un monteur fait, et ce que la coupe unique ne sait pas faire.
  const m1 = moments[0];
  const inside = segments.filter((s) => s.startSec >= m1.startSec && s.endSec <= m1.endSec);
  const dropped = inside[Math.floor(inside.length / 2)];
  const m2 = moments[1] ?? moments[0];

  const planFromClaude = `Voici deux clips tirés de cet épisode.

\`\`\`json
{
  "version": "clipflow-plan-1",
  "clips": [
    {
      "title": "Sept ans sur le mauvais problème",
      "hook": ${JSON.stringify(m1.hooks[0]?.text ?? "Ce que personne ne te dit")},
      "caption": "Le jour où il a arrêté d'optimiser ce que personne ne voulait acheter.",
      "hashtags": ["business", "entrepreneuriat"],
      "cuts": [
        { "start": ${m1.startSec}, "end": ${dropped.startSec}, "note": "l'aveu et sa mise en place" },
        { "start": ${dropped.endSec}, "end": ${m1.endSec}, "note": "on saute la relance de l'hôte et on recolle sur la chute", "zoom": 1.08 }
      ],
      "framing": "fit-blur",
      "burnSubtitles": true,
      "rationale": "On garde l'aveu brut, on retire la relance de l'hôte qui casse le rythme au milieu, et on recolle directement sur le résultat. Le clip tient seul."
    },
    {
      "title": "La fréquence bat la perfection",
      "hook": ${JSON.stringify(m2.hooks[0]?.text ?? "68 % contre 11 %")},
      "caption": "Même contenu, même qualité. Seule la fréquence change.",
      "hashtags": ["contenu", "audience"],
      "cuts": [
        { "start": ${m2.startSec}, "end": ${m2.endSec}, "note": "le contraste chiffré, d'un bloc" }
      ],
      "framing": "cover",
      "burnSubtitles": true,
      "rationale": "Le contraste chiffré tient seul en une coupe : le découper l'affaiblirait."
    }
  ]
}
\`\`\``;

  const planResult = await createPlansFromInput({
    rushId: report.rushId,
    raw: planFromClaude,
    source: "CLAUDE_CHAT",
    author: "Claude (chat)",
  });
  console.log(`   ${planResult.created.length} plan(s) enregistré(s)`);
  for (const i of planResult.issues) console.log(`   ${i.level === "error" ? "✗" : "!"} ${i.message}`);

  console.log("\n→ Rendu FFmpeg des montages");
  const clipIds: string[] = [];
  for (const planId of planResult.created) {
    const clip = await renderPlan(planId);
    clipIds.push(clip.id);
    const cuts = (clip.cutsSummary as unknown as Array<{ start: number; end: number }>) ?? [];
    console.log(`   ✓ ${clip.title} — ${cuts.length} coupe(s), ${clip.durationSec?.toFixed(1)} s, QA ${clip.qaScore}/100`);
  }

  console.log("\n→ Validation et publication");
  for (const id of clipIds) {
    await reviewClip({ clipId: id, decision: "APPROVED", reviewerId: me.id, comment: "Validé" });
  }
  for (const [i, id] of clipIds.entries()) {
    await queueClipPublications({
      clipId: id,
      networks: (top.targetNetworks.length ? top.targetNetworks : ["instagram", "tiktok"]) as never,
      scheduledAt: new Date(Date.now() + (3 + i * 5) * 3600_000),
    });
  }
  const queued = await processQueue(50);
  console.log(`   ${queued.scheduled} publication(s) planifiée(s), ${queued.failed} en échec`);

  // Quelques vues, pour que les chiffres ne soient pas vides.
  for (const [i, id] of clipIds.entries()) {
    const views = [142_000, 38_000][i % 2];
    await prisma.clip.update({
      where: { id },
      data: { views, likes: Math.round(views * 0.07), shares: Math.round(views * 0.015) },
    });
  }

  const brief = await buildEditBrief(report.rushId);
  const counts = {
    clients: await prisma.client.count(),
    rushes: await prisma.rush.count(),
    moments: await prisma.moment.count(),
    hooks: await prisma.hook.count(),
    plans: await prisma.editPlan.count(),
    clips: await prisma.clip.count(),
    publications: await prisma.publication.count(),
  };
  console.log("\n→ Base peuplée :", counts);
  console.log(`   brief prêt : ${(brief.approxChars / 1000).toFixed(1)} k caractères`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
