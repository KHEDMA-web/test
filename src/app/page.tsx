import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Stat, StatusBadge, ScorePill, Meter } from "@/components/ui";
import { integrationStatuses } from "@/lib/config";
import { formatCompact, formatCents, relativeTime } from "@/lib/utils";
import { demoRushAction, processQueueAction } from "@/app/actions";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

const STAGES = [
  { n: 1, key: "clients", label: "Clients payants (Whop)", href: "/clients", color: "var(--stage-1)" },
  { n: 2, key: "rushes", label: "Rushes analysés", href: "/rushes", color: "var(--stage-2)" },
  { n: 3, key: "plans", label: "Montages décidés avec Claude", href: "/montage", color: "var(--stage-3)" },
  { n: 4, key: "clips", label: "Clips validés", href: "/review", color: "var(--stage-4)" },
  { n: 5, key: "published", label: "Publiés via Metricool", href: "/publishing", color: "var(--stage-5)" },
];

export default async function DashboardPage() {
  const [
    clients,
    activeClients,
    rushes,
    readyRushes,
    moments,
    plans,
    claudePlans,
    clips,
    approvedClips,
    toReview,
    publications,
    scheduledPubs,
    publishedPubs,
    failedPubs,
    events,
    totalViews,
    topClients,
  ] = await Promise.all([
    prisma.client.count(),
    prisma.client.findMany({ where: { status: { in: ["ACTIVE", "TRIAL"] } } }),
    prisma.rush.count(),
    prisma.rush.count({ where: { status: "READY" } }),
    prisma.moment.count(),
    prisma.editPlan.count(),
    prisma.editPlan.count({ where: { source: { in: ["CLAUDE_CHAT", "CLAUDE_CODE"] } } }),
    prisma.clip.count(),
    prisma.clip.count({ where: { status: { in: ["APPROVED", "SCHEDULED", "PUBLISHED"] } } }),
    prisma.clip.count({ where: { status: "READY" } }),
    prisma.publication.count(),
    prisma.publication.count({ where: { status: "SCHEDULED" } }),
    prisma.publication.count({ where: { status: "PUBLISHED" } }),
    prisma.publication.count({ where: { status: "FAILED" } }),
    prisma.pipelineEvent.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
    prisma.clip.aggregate({ _sum: { views: true } }),
    prisma.client.findMany({
      where: { status: { in: ["ACTIVE", "TRIAL"] } },
      orderBy: { mrrCents: "desc" },
      take: 4,
    }),
  ]);

  const counts: Record<string, number> = {
    clients: activeClients.length,
    rushes: readyRushes,
    plans,
    clips: approvedClips,
    published: publishedPubs + scheduledPubs,
  };
  const maxCount = Math.max(...Object.values(counts), 1);
  const integrations = integrationStatuses();
  const mockCount = integrations.filter((i) => i.mode === "mock").length;

  const mrr = activeClients.reduce((s, c) => s + c.mrrCents, 0);
  const committed = activeClients.reduce((s, c) => s + c.clipsPerMonth, 0);
  const delivered = activeClients.reduce((s, c) => s + c.clipsDelivered, 0);

  return (
    <>
      <PageHeader
        title="Mon atelier de clipping"
        description="Whop m'amène des clients qui paient pour du clipping. Je récupère ou je vais chercher leur matière, je la fais analyser, je monte avec Claude, et Metricool publie. Chaque étage est repris indépendamment."
        actions={
          <>
            <form action={processQueueAction}>
              <SubmitButton pendingLabel="Traitement…">Traiter la file Metricool</SubmitButton>
            </form>
            <form action={demoRushAction}>
              <input type="hidden" name="clientId" value={activeClients[0]?.id ?? ""} />
              <SubmitButton className="btn-primary" pendingLabel="Analyse en cours…">Rush de test</SubmitButton>
            </form>
          </>
        }
      />

      {mockCount > 0 ? (
        <div className="card" style={{ padding: "0.7rem 1rem", marginBottom: "1.4rem", borderColor: "#f59e0b44", background: "#f59e0b0d", fontSize: "0.84rem" }}>
          <strong style={{ color: "#fbbf24" }}>{mockCount} intégration(s) en mode mock.</strong>{" "}
          <span style={{ color: "var(--text-muted)" }}>
            Tout tourne sans appel réseau. Les clés se renseignent dans{" "}
            <Link href="/settings" style={{ color: "var(--accent)" }}>Réglages</Link>.
          </span>
        </div>
      ) : null}

      <section className="card" style={{ padding: "1.3rem 1.4rem", marginBottom: "1.4rem" }}>
        <h2 style={{ margin: "0 0 1.1rem", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-faint)" }}>
          Le flux
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
        <Stat label="Revenu mensuel" value={formatCents(mrr)} sub={`${activeClients.length} client(s) actifs sur ${clients}`} accent="#4ade80" />
        <Stat label="Clips du mois" value={`${delivered} / ${committed}`} sub="livrés sur engagés" accent={delivered < committed ? "#fbbf24" : "#4ade80"} />
        <Stat label="Rushes" value={rushes} sub={`${readyRushes} analysés · ${moments} moments`} />
        <Stat label="Montages" value={plans} sub={`${claudePlans} décidés avec Claude`} accent="#c084fc" />
        <Stat label="Clips" value={clips} sub={`${approvedClips} validés · ${toReview} à relire`} accent={toReview > 0 ? "#fbbf24" : undefined} />
        <Stat
          label="Publications"
          value={publications}
          sub={`${scheduledPubs} planifiées · ${publishedPubs} publiées${failedPubs ? ` · ${failedPubs} en échec` : ""}`}
          accent={failedPubs > 0 ? "#f87171" : undefined}
        />
        <Stat label="Vues cumulées" value={formatCompact(totalViews._sum.views ?? 0)} sub="sur les clips livrés" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: "1rem", alignItems: "start" }}>
        <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
          <h2 style={{ margin: "0 0 0.9rem", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-faint)" }}>
            Journal
          </h2>
          {events.length === 0 ? (
            <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Rien pour l'instant.</p>
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
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.9rem", fontSize: "0.78rem", textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-faint)" }}>
              Mes plus gros clients
            </h2>
            {topClients.length === 0 ? (
              <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>Aucun client actif.</p>
            ) : (
              <div style={{ display: "grid", gap: "0.8rem" }}>
                {topClients.map((c) => (
                  <div key={c.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
                      <span style={{ fontSize: "0.85rem", fontWeight: 500 }}>{c.name}</span>
                      <span style={{ display: "flex", gap: "0.35rem" }}>
                        <StatusBadge status={c.status} />
                        <ScorePill score={c.score} />
                      </span>
                    </div>
                    <Meter value={c.clipsDelivered} max={Math.max(1, c.clipsPerMonth)} />
                    <div style={{ fontSize: "0.72rem", color: "var(--text-faint)", marginTop: "0.25rem" }}>
                      {formatCents(c.mrrCents)}/mois · {c.clipsDelivered}/{c.clipsPerMonth} clips livrés
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

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
    </>
  );
}
