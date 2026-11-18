/**
 * Seed : monte une plateforme déjà vivante.
 *  1. Un compte admin et un créateur de contenu
 *  2. Une campagne de clipping
 *  3. La synchro Whop (mock) : candidatures scorées + clippers acceptés
 *  4. Un rush de démonstration passé dans tout le pipeline
 */
import { prisma } from "../src/lib/db";
import { syncAllMemberships, recomputeClipperScores } from "../src/lib/whop/sync";
import { runFullPipeline } from "../src/lib/pipeline/orchestrator";
import { generateTestRush } from "../src/lib/render/ffmpeg";
import { ensureStorage, storagePath } from "../src/lib/storage";
import { slugify } from "../src/lib/utils";

async function main() {
  console.log("→ Nettoyage");
  await prisma.$transaction([
    prisma.pipelineEvent.deleteMany(),
    prisma.publication.deleteMany(),
    prisma.payout.deleteMany(),
    prisma.clipReview.deleteMany(),
    prisma.clip.deleteMany(),
    prisma.hook.deleteMany(),
    prisma.moment.deleteMany(),
    prisma.transcriptSegment.deleteMany(),
    prisma.assignment.deleteMany(),
    prisma.rush.deleteMany(),
    prisma.campaign.deleteMany(),
    prisma.application.deleteMany(),
    prisma.whopMembership.deleteMany(),
    prisma.clipperProfile.deleteMany(),
    prisma.user.deleteMany(),
    prisma.webhookEvent.deleteMany(),
  ]);

  console.log("→ Comptes");
  const admin = await prisma.user.create({
    data: { email: "admin@clipflow.local", name: "Opérateur ClipFlow", role: "ADMIN" },
  });
  const creator = await prisma.user.create({
    data: { email: "creator@clipflow.local", name: "Studio Podcast", role: "CREATOR" },
  });

  console.log("→ Campagne");
  const campaign = await prisma.campaign.create({
    data: {
      name: "Podcast Business — saison 3",
      slug: slugify("Podcast Business saison 3"),
      ownerId: creator.id,
      status: "ACTIVE",
      brief:
        "Clips verticaux tirés des épisodes longs. On cherche les passages qui tiennent seuls : une idée, un retournement, une chute. Pas d'intro, pas de remerciements.",
      hookGuidelines:
        "Hook en moins de 50 caractères, pas de majuscules criées, pas d'emoji. Privilégier les chiffres du passage et les formulations contre-intuitives. Le hook doit être tenu par le contenu.",
      targetNetworks: ["instagram", "tiktok", "youtube"],
      minClipSeconds: 18,
      maxClipSeconds: 60,
      clipsPerRush: 6,
      cpmCents: 250,
      flatRateCents: 1500,
      budgetCents: 500_000,
    },
  });

  console.log("→ Synchro Whop (recrutement)");
  const sync = await syncAllMemberships();
  console.log(`   ${sync.total} membership(s) — ${sync.granted} accès clipper (mode ${sync.mode})`);

  // Historique de performance, pour que les scores de clipper soient parlants.
  const profiles = await prisma.clipperProfile.findMany({ include: { user: true } });
  const history = [
    { submitted: 42, approved: 39, published: 37, views: 5_900_000, onTime: 96, turnaround: 9 },
    { submitted: 18, approved: 14, published: 13, views: 820_000, onTime: 83, turnaround: 19 },
    { submitted: 6, approved: 4, published: 4, views: 96_000, onTime: 67, turnaround: 31 },
    { submitted: 1, approved: 0, published: 0, views: 0, onTime: 0, turnaround: 0 },
  ];
  for (const [i, p] of profiles.entries()) {
    const h = history[i % history.length];
    await prisma.clipperProfile.update({
      where: { id: p.id },
      data: {
        clipsSubmitted: h.submitted,
        clipsApproved: h.approved,
        clipsRejected: h.submitted - h.approved,
        clipsPublished: h.published,
        totalViews: h.views,
        onTimeRate: h.onTime,
        medianTurnaroundH: h.turnaround,
        lastClipAt: h.published ? new Date(Date.now() - (i + 1) * 3 * 864e5) : null,
      },
    });
  }
  const recomputed = await recomputeClipperScores();
  console.log(`   ${recomputed} score(s) de clipper recalculés`);

  console.log("→ Rush de démonstration (généré avec ffmpeg)");
  await ensureStorage();
  const rushPath = storagePath("rush", "demo-episode-12.mp4");
  await generateTestRush(rushPath, 240);

  console.log("→ Pipeline complet");
  const report = await runFullPipeline(
    {
      title: "Épisode 12 — « La discipline ne suffit pas »",
      description: "Rush brut de l'épisode long, 4 minutes de démonstration.",
      campaignId: campaign.id,
      uploaderId: creator.id,
      filePath: rushPath,
      language: "fr",
    },
    {
      draftCount: 3,
      assign: true,
      autoApprove: true,
      publish: true,
      networks: ["instagram", "tiktok", "youtube"],
      flushQueue: true,
    },
  );

  for (const s of report.steps) console.log(`   ${s.ok ? "✓" : "✗"} ${s.stage} — ${s.detail}`);
  for (const w of report.warnings) console.log(`   ! ${w}`);

  // Quelques vues simulées, pour que les scores et la rémunération vivent.
  const published = await prisma.clip.findMany({ where: { status: { in: ["PUBLISHED", "SCHEDULED"] } } });
  for (const [i, c] of published.entries()) {
    const views = [184_000, 61_000, 23_500][i % 3];
    await prisma.clip.update({
      where: { id: c.id },
      data: { views, likes: Math.round(views * 0.06), shares: Math.round(views * 0.012) },
    });
    if (c.clipperId) {
      const profile = await prisma.clipperProfile.findUnique({ where: { userId: c.clipperId } });
      if (profile) {
        await prisma.payout.create({
          data: {
            campaignId: campaign.id,
            clipperId: profile.id,
            clipId: c.id,
            amountCents: campaign.flatRateCents + Math.round((views / 1000) * campaign.cpmCents),
            basis: "cpm",
            views,
          },
        });
      }
    }
  }

  await prisma.setting.upsert({
    where: { key: "demand_niches" },
    create: { key: "demand_niches", value: "business,mindset,podcast,tech" },
    update: { value: "business,mindset,podcast,tech" },
  });

  const counts = {
    users: await prisma.user.count(),
    candidatures: await prisma.application.count(),
    clippers: await prisma.clipperProfile.count(),
    moments: await prisma.moment.count(),
    hooks: await prisma.hook.count(),
    clips: await prisma.clip.count(),
    publications: await prisma.publication.count(),
  };
  console.log("\n→ Base peuplée :", counts);
  console.log(`   admin : ${admin.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
