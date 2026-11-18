import { prisma } from "@/lib/db";
import { PageHeader, Stat, StatusBadge, ScorePill, Meter, Empty, ScoreBreakdown, type Criterion } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { syncWhopAction, decideApplicationAction } from "@/app/actions";
import { formatCompact, relativeTime } from "@/lib/utils";
import { whop } from "@/lib/whop/client";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

type Breakdown = { score: number; components: Criterion[]; decision: string; summary: string };

export default async function RecruitmentPage() {
  const [applications, clippers, memberships, counts] = await Promise.all([
    prisma.application.findMany({ orderBy: [{ score: "desc" }, { createdAt: "desc" }], include: { user: true } }),
    prisma.clipperProfile.findMany({
      orderBy: { score: "desc" },
      include: { user: true, assignments: { where: { status: { in: ["OPEN", "IN_PROGRESS"] } }, select: { id: true } } },
    }),
    prisma.whopMembership.count({ where: { valid: true } }),
    prisma.application.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));
  const mode = whop.mode();

  return (
    <>
      <PageHeader
        stage="Étage 1 · Whop"
        title="Recrutement des clippers"
        description="Les candidatures arrivent par Whop (webhook signé ou synchronisation). Chaque dossier est noté sur six critères : preuves de travail, traction passée, niche demandée, audience, outils, validité du membership. Au-dessus de 70, l'accès est accordé automatiquement ; entre 45 et 70, la décision reste humaine."
        actions={
          <form action={syncWhopAction}>
            <SubmitButton className="btn-primary" pendingLabel="Synchronisation…">
              Synchroniser Whop
            </SubmitButton>
          </form>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="Candidatures" value={applications.length} sub={`${byStatus.PENDING ?? 0} en attente`} />
        <Stat label="Acceptées" value={byStatus.ACCEPTED ?? 0} sub="accès clipper accordé" accent="#4ade80" />
        <Stat label="Présélectionnées" value={byStatus.SHORTLISTED ?? 0} sub="décision humaine requise" accent="#22d3ee" />
        <Stat label="Memberships valides" value={memberships} sub={`API Whop en mode ${mode}`} />
        <Stat label="Clippers actifs" value={clippers.filter((c) => !c.blocked).length} sub={`produit ${config.whop.productId || "non configuré"}`} />
      </div>

      <section className="card" style={{ marginBottom: "1.4rem", overflow: "hidden" }}>
        <div style={{ padding: "1rem 1.2rem", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>Candidatures scorées</h2>
          <p style={{ margin: "0.3rem 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Dépliez une ligne pour voir le détail du score, critère par critère.
          </p>
        </div>

        {applications.length === 0 ? (
          <Empty title="Aucune candidature" hint="Lancez une synchronisation Whop pour importer les memberships." />
        ) : (
          <div>
            {applications.map((a) => {
              const bd = a.scoreBreakdown as unknown as Breakdown | null;
              return (
                <details key={a.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <summary
                    style={{
                      display: "grid",
                      gridTemplateColumns: "minmax(0,2fr) 7rem minmax(0,1.3fr) 8rem auto",
                      gap: "1rem",
                      alignItems: "center",
                      padding: "0.85rem 1.2rem",
                      cursor: "pointer",
                      listStyle: "none",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 550, fontSize: "0.88rem" }}>{a.displayName}</div>
                      <div style={{ fontSize: "0.74rem", color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {a.email} · {a.niches.join(", ") || "niche non précisée"}
                      </div>
                    </div>
                    <ScorePill score={a.score} />
                    <div>
                      <Meter value={a.score} />
                      <div style={{ fontSize: "0.72rem", color: "var(--text-faint)", marginTop: "0.25rem" }}>
                        {formatCompact(a.pastClipViews ?? 0)} vues · {a.portfolioUrls.length} réf. · {formatCompact(a.followerCount ?? 0)} abonnés
                      </div>
                    </div>
                    <StatusBadge status={a.status} />
                    <span style={{ fontSize: "0.72rem", color: "var(--text-faint)", whiteSpace: "nowrap" }}>{relativeTime(a.createdAt)}</span>
                  </summary>

                  <div style={{ padding: "0 1.2rem 1.2rem", display: "grid", gridTemplateColumns: "minmax(0,1fr) 16rem", gap: "1.5rem" }}>
                    <div>
                      {bd?.components ? <ScoreBreakdown criteria={bd.components} /> : <p style={{ color: "var(--text-muted)" }}>Détail indisponible.</p>}
                      {bd?.summary ? (
                        <p style={{ marginTop: "0.9rem", fontSize: "0.82rem", color: "var(--text-muted)", fontStyle: "italic" }}>{bd.summary}</p>
                      ) : null}
                    </div>

                    <div style={{ display: "grid", gap: "0.5rem", alignContent: "start" }}>
                      <div style={{ fontSize: "0.72rem", color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Décision</div>
                      {(["ACCEPTED", "SHORTLISTED", "REJECTED"] as const).map((d) => (
                        <form key={d} action={decideApplicationAction}>
                          <input type="hidden" name="applicationId" value={a.id} />
                          <input type="hidden" name="decision" value={d} />
                          <SubmitButton className={d === "ACCEPTED" ? "btn-ok" : d === "REJECTED" ? "btn-danger" : ""}>
                            {d === "ACCEPTED" ? "Donner l'accès" : d === "SHORTLISTED" ? "Mettre en attente" : "Écarter"}
                          </SubmitButton>
                        </form>
                      ))}
                      {a.portfolioUrls.length ? (
                        <div style={{ marginTop: "0.5rem", fontSize: "0.74rem", color: "var(--text-faint)" }}>
                          Portfolio :
                          <ul style={{ margin: "0.3rem 0 0", paddingLeft: "1rem" }}>
                            {a.portfolioUrls.slice(0, 4).map((u) => (
                              <li key={u} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                                <a href={u} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{u.replace(/^https?:\/\//, "")}</a>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>

      <section className="card" style={{ overflow: "hidden" }}>
        <div style={{ padding: "1rem 1.2rem", borderBottom: "1px solid var(--border)" }}>
          <h2 style={{ margin: 0, fontSize: "0.95rem", fontWeight: 600 }}>Clippers recrutés</h2>
          <p style={{ margin: "0.3rem 0 0", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Classés sur leurs résultats réels : validation, vues moyennes, ponctualité, volume, activité récente.
          </p>
        </div>
        {clippers.length === 0 ? (
          <Empty title="Aucun clipper" hint="Acceptez une candidature pour ouvrir un accès." />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Clipper</th>
                <th>Niveau</th>
                <th style={{ width: "11rem" }}>Score</th>
                <th>Validés</th>
                <th>Vues / clip</th>
                <th>Délai médian</th>
                <th>Charge</th>
                <th>Niches</th>
              </tr>
            </thead>
            <tbody>
              {clippers.map((c) => (
                <tr key={c.id} style={{ opacity: c.blocked ? 0.45 : 1 }}>
                  <td>
                    <div style={{ fontWeight: 550 }}>{c.user.name}</div>
                    <div style={{ fontSize: "0.72rem", color: "var(--text-faint)" }}>
                      {c.user.whopUsername ? `@${c.user.whopUsername}` : c.user.email}
                      {c.blocked ? " · accès suspendu" : ""}
                    </div>
                  </td>
                  <td><StatusBadge status={c.tier} /></td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <Meter value={c.score} />
                      <span className="mono" style={{ fontSize: "0.78rem" }}>{c.score}</span>
                    </div>
                  </td>
                  <td className="mono">{c.clipsApproved}/{c.clipsSubmitted}</td>
                  <td className="mono">{formatCompact(c.avgViews)}</td>
                  <td className="mono">{c.medianTurnaroundH ? `${Math.round(c.medianTurnaroundH)} h` : "—"}</td>
                  <td className="mono">{c.assignments.length}</td>
                  <td style={{ fontSize: "0.76rem", color: "var(--text-muted)" }}>{c.niches.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
