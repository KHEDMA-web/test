import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Stat, StatusBadge, ScorePill, Meter } from "@/components/ui";
import { integrationStatuses } from "@/lib/config";
import { formatCompact, relativeTime, formatDateTime } from "@/lib/utils";
import { runDemoPipelineAction, processQueueAction } from "@/app/actions";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

const STAGES = [
  { n: 1, key: "whop", label: "Recrutement Whop", href: "/recruitment", color: "var(--stage-1)" },
  { n: 2, key: "rush", label: "Rushes transcrits", href: "/rushes", color: "var(--stage-2)" },
  { n: 3, key: "moments", label: "Moments & hooks", href: "/rushes", color: "var(--stage-3)" },
  { n: 4, key: "clips", label: "Clips montés", href: "/studio", color: "var(--stage-4)" },
  { n: 5, key: "published", label: "Publiés via Metricool", href: "/publishing", color: "var(--stage-5)" },
];

export default async function DashboardPage() {
  const [
    applications,
    acceptedApps,
    clippers,
    rushes,
    readyRushes,
    moments,
    hooks,
    clips,
    approvedClips,
    publications,
    scheduledPubs,
    publishedPubs,
    failedPubs,
    events,
    topClippers,
    totalViews,
    pendingReview,
  ] = await Promise.all([
    prisma.application.count(),
    prisma.application.count({ where: { status: "ACCEPTED" } }),
    prisma.clipperProfile.count({ where: { blocked: false } }),
    prisma.rush.count(),
    prisma.rush.count({ where: { status: "READY" } }),
    prisma.moment.count(),
    prisma.hook.count(),
    prisma.clip.count(),
    prisma.clip.count({ where: { status: { in: ["APPROVED", "SCHEDULED", "PUBLISHED"] } } }),
    prisma.publication.count(),
    prisma.publication.count({ where: { status: "SCHEDULED" } }),
    prisma.publication.count({ where: { status: "PUBLISHED" } }),
    prisma.publication.count({ where: { status: "FAILED" } }),
    prisma.pipelineEvent.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.clipperProfile.findMany({
      where: { blocked: false },
      orderBy: { score: "desc" },
      take: 4,
      include: { user: true },
    }),
    prisma.clip.aggregate({ _sum: { views: true } }),
    prisma.clip.count({ where: { status: "SUBMITTED" } }),
  ]);

  const counts: Record<string, number> = {
    whop: acceptedApps,
    rush: readyRushes,
    moments,
    clips,
    published: publishedPubs + scheduledPubs,
  };
  const maxCount = Math.max(...Object.values(counts), 1);
  const integrations = integrationStatuses();
  const mockCount = integrations.filter((i) => i.mode === "mock").length;

  const campaign = await prisma.campaign.findFirst({ where: { status: "ACTIVE" } });

  return (
    <>
      <PageHeader
        title="Pipeline de clipping"
        description="Le flux complet, de la candidature d'un clipper sur Whop jusqu'à la publication programmée. Chaque étage est autonome : on peut reprendre une étape sans refaire les précédentes."
        actions={
          <>
            <form action={processQueueAction}>
              <SubmitButton pendingLabel="Traitement…">Traiter la file Metricool</SubmitButton>
            </form>
            <form action={runDemoPipelineAction}>
              <input type="hidden" name="campaignId" value={campaign?.id ?? ""} />
              <SubmitButton className="btn-primary" pendingLabel="Pipeline en cours…">
                Lancer un rush de test
              </SubmitButton>
            </form>
          </>
        }
      />

      {mockCount > 0 ? (
        <div
          className="card"
          style={{ padding: "0.7rem 1rem", marginBottom: "1.4rem", borderColor: "#f59e0b44", background: "#f59e0b0d", fontSize: "0.84rem" }}
        >
          <strong style={{ color: "#fbbf24" }}>{mockCount} intégration(s) en mode mock.</strong>{" "}
          <span style={{ color: "var(--text-muted)" }}>
            Le flux tourne de bout en bout sans appel réseau. Renseignez les clés dans{" "}
            <Link href="/settings" style={{ color: "var(--accent)" }}>Réglages</Link> pour basculer en réel.
          </span>
        </div>
      ) : null}

      {/* ── Entonnoir ─────────────────────────────────────── */}
      <section className="card" style={{ padding: "1.3rem 1.4rem", marginBottom: "1.4rem" }}>
        <h2 style={{ margin: "0 0 1.1rem", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-faint)" }}>
          Entonnoir du flux
        </h2>
        <div style={{ display: "grid", gap: "0.9rem" }}>
          {STAGES.map((s) => {
            const value = counts[s.key] ?? 0;
            return (
              <Link key={s.n} href={s.href} style={{ display: "grid", gridTemplateColumns: "2rem 1fr auto", gap: "0.9rem", alignItems: "center" }}>
                <span
                  className="mono"
                  style={{
                    width: "1.65rem",
                    height: "1.65rem",
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 7,
                    border: `1px solid ${s.color}55`,
                    color: s.color,
                    fontSize: "0.75rem",
                    fontWeight: 700,
                  }}
                >
                  {s.n}
                </span>
                <div>
                  <div style={{ fontSize: "0.86rem", marginBottom: "0.35rem" }}>{s.label}</div>
                  <div className="meter">
                    <span style={{ width: `${Math.max(4, (value / maxCount) * 100)}%`, background: s.color }} />
                  </div>
                </div>
                <span className="mono" style={{ fontSize: "1.05rem", fontWeight: 600, color: s.color, minWidth: "2.5rem", textAlign: "right" }}>
                  {value}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="Candidatures" value={applications} sub={`${acceptedApps} acceptées · ${clippers} clippers actifs`} />
        <Stat label="Rushes" value={rushes} sub={`${readyRushes} prêts à monter`} />
        <Stat label="Moments / hooks" value={`${moments} / ${hooks}`} sub="détectés et scorés" />
        <Stat label="Clips" value={clips} sub={`${approvedClips} validés · ${pendingReview} à valider`} accent={pendingReview > 0 ? "#fbbf24" : undefined} />
        <Stat
          label="Publications"
          value={publications}
          sub={`${scheduledPubs} planifiées · ${publishedPubs} publiées${failedPubs ? ` · ${failedPubs} en échec` : ""}`}
          accent={failedPubs > 0 ? "#f87171" : undefined}
        />
        <Stat label="Vues cumulées" value={formatCompact(totalViews._sum.views ?? 0)} sub="sur les clips publiés" accent="#4ade80" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: "1rem", alignItems: "start" }}>
        {/* ── Journal ──────────────────────────────────────── */}
        <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
          <h2 style={{ margin: "0 0 0.9rem", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-faint)" }}>
            Journal du pipeline
          </h2>
          {events.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Rien pour l'instant. Lancez un rush de test.</p>
          ) : (
            <div style={{ display: "grid", gap: "0.1rem" }}>
              {events.map((e) => (
                <div key={e.id} style={{ display: "flex", gap: "0.7rem", padding: "0.5rem 0", borderBottom: "1px solid var(--border)", fontSize: "0.82rem" }}>
                  <span className="badge" style={{ minWidth: "5.2rem", justifyContent: "center", textTransform: "uppercase", fontSize: "0.62rem" }}>
                    {e.stage}
                  </span>
                  <span style={{ flex: 1, color: e.level === "error" ? "#f87171" : "var(--text)" }}>{e.message}</span>
                  <span className="mono" style={{ color: "var(--text-faint)", fontSize: "0.72rem", whiteSpace: "nowrap" }}>
                    {relativeTime(e.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <div style={{ display: "grid", gap: "1rem" }}>
          {/* ── Meilleurs clippers ─────────────────────────── */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.9rem", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-faint)" }}>
              Meilleurs clippers
            </h2>
            {topClippers.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Aucun clipper recruté.</p>
            ) : (
              <div style={{ display: "grid", gap: "0.8rem" }}>
                {topClippers.map((c) => (
                  <div key={c.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
                      <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>{c.user.name}</span>
                      <span style={{ display: "flex", gap: "0.35rem" }}>
                        <StatusBadge status={c.tier} />
                        <ScorePill score={c.score} />
                      </span>
                    </div>
                    <Meter value={c.score} />
                    <div style={{ fontSize: "0.72rem", color: "var(--text-faint)", marginTop: "0.25rem" }}>
                      {c.clipsPublished} clips · {formatCompact(c.avgViews)} vues/clip · {Math.round(c.approvalRate)} % validés
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── État des intégrations ──────────────────────── */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.9rem", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-faint)" }}>
              Intégrations
            </h2>
            <div style={{ display: "grid", gap: "0.5rem" }}>
              {integrations.map((i) => (
                <div key={i.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.6rem", fontSize: "0.8rem" }}>
                  <span style={{ color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.label}</span>
                  <span
                    className="badge"
                    style={
                      i.mode === "live"
                        ? { color: "#4ade80", borderColor: "#22c55e44", background: "#22c55e14" }
                        : { color: "#fbbf24", borderColor: "#f59e0b44", background: "#f59e0b14" }
                    }
                  >
                    {i.mode === "live" ? "réel" : "mock"}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {events[0] ? (
        <p style={{ marginTop: "1.2rem", fontSize: "0.74rem", color: "var(--text-faint)" }}>
          Dernière activité : {formatDateTime(events[0].createdAt)}
        </p>
      ) : null}
    </>
  );
}
