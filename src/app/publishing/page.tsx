import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { processQueueAction } from "@/app/actions";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { metricool } from "@/lib/metricool/client";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

const DAY_MS = 864e5;

export default async function PublishingPage() {
  const [publications, counts] = await Promise.all([
    prisma.publication.findMany({
      orderBy: { scheduledAt: "asc" },
      include: { clip: { include: { campaign: true } } },
    }),
    prisma.publication.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const mode = metricool.mode();

  // Calendrier des 7 prochains jours.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => new Date(today.getTime() + i * DAY_MS));
  const upcoming = publications.filter(
    (p) => p.scheduledAt >= today && p.scheduledAt < new Date(today.getTime() + 7 * DAY_MS),
  );

  return (
    <>
      <PageHeader
        stage="Étage 5 · Metricool"
        title="Publication"
        description="Chaque clip validé devient une publication par réseau. La file envoie à l'API Metricool (POST /v2/scheduler/posts, en-tête X-Mc-Auth, date locale sans décalage + fuseau). Les erreurs récupérables sont rejouées, les refus définitifs sont marqués en échec sans boucler."
        actions={
          <form action={processQueueAction}>
            <SubmitButton className="btn-primary" pendingLabel="Envoi en cours…">Traiter la file</SubmitButton>
          </form>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="En file" value={byStatus.QUEUED ?? 0} accent={byStatus.QUEUED ? "#fbbf24" : undefined} />
        <Stat label="Planifiées" value={byStatus.SCHEDULED ?? 0} accent="#22d3ee" />
        <Stat label="Publiées" value={byStatus.PUBLISHED ?? 0} accent="#4ade80" />
        <Stat label="En échec" value={byStatus.FAILED ?? 0} accent={byStatus.FAILED ? "#f87171" : undefined} />
        <Stat label="Metricool" value={mode === "live" ? "réel" : "mock"} sub={`fuseau ${config.metricool.timezone}`} />
      </div>

      {/* ── Calendrier ────────────────────────────────────── */}
      <section className="card" style={{ padding: "1.1rem 1.2rem", marginBottom: "1.4rem" }}>
        <h2 style={{ margin: "0 0 0.9rem", fontSize: "0.88rem", fontWeight: 600 }}>Sept prochains jours</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: "0.6rem" }}>
          {days.map((d) => {
            const dayPubs = upcoming.filter((p) => p.scheduledAt.toDateString() === d.toDateString());
            const isToday = d.toDateString() === new Date().toDateString();
            return (
              <div
                key={d.toISOString()}
                style={{
                  border: `1px solid ${isToday ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 9,
                  padding: "0.6rem 0.5rem",
                  minHeight: 120,
                  background: isToday ? "var(--accent-soft)" : "var(--bg-subtle)",
                }}
              >
                <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", marginBottom: "0.5rem", textTransform: "capitalize" }}>
                  {d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" })}
                </div>
                <div style={{ display: "grid", gap: "0.3rem" }}>
                  {dayPubs.slice(0, 4).map((p) => (
                    <Link
                      key={p.id}
                      href={`/studio/${p.clipId}`}
                      style={{
                        fontSize: "0.66rem",
                        padding: "0.2rem 0.35rem",
                        borderRadius: 5,
                        background: "var(--bg-elevated)",
                        border: "1px solid var(--border)",
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={`${p.network} · ${p.scheduledAtLocal}`}
                    >
                      <span className="mono" style={{ color: "var(--text-faint)" }}>
                        {p.scheduledAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                      </span>{" "}
                      {p.network}
                    </Link>
                  ))}
                  {dayPubs.length > 4 ? (
                    <span style={{ fontSize: "0.66rem", color: "var(--text-faint)" }}>+{dayPubs.length - 4}</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {publications.length === 0 ? (
        <Empty title="Aucune publication" hint="Validez un clip puis mettez-le en file depuis la page Validation." />
      ) : (
        <section className="card" style={{ overflow: "hidden" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Clip</th>
                <th>Réseau</th>
                <th>Heure locale</th>
                <th>Statut</th>
                <th>Tentatives</th>
                <th>Post Metricool</th>
                <th>Détail</th>
              </tr>
            </thead>
            <tbody>
              {publications.map((p) => (
                <tr key={p.id}>
                  <td style={{ maxWidth: "22rem" }}>
                    <Link href={`/studio/${p.clipId}`} style={{ fontWeight: 500 }}>{p.clip.title}</Link>
                    <div style={{ fontSize: "0.72rem", color: "var(--text-faint)" }}>{p.clip.campaign?.name ?? "sans campagne"}</div>
                  </td>
                  <td><span className="badge">{p.network}</span></td>
                  <td className="mono" style={{ fontSize: "0.76rem" }}>
                    {p.scheduledAtLocal}
                    <div style={{ color: "var(--text-faint)", fontSize: "0.7rem" }}>{p.timezone}</div>
                  </td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="mono">{p.attempts}</td>
                  <td className="mono" style={{ fontSize: "0.73rem", color: "var(--text-faint)" }}>{p.metricoolPostId ?? "—"}</td>
                  <td style={{ fontSize: "0.73rem", color: p.lastError ? "#f87171" : "var(--text-faint)", maxWidth: "20rem" }}>
                    {p.lastError ?? (p.publishedAt ? `publié ${relativeTime(p.publishedAt)}` : formatDateTime(p.createdAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
