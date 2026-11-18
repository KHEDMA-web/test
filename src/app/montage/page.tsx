import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Stat, StatusBadge, Empty, Meter, scoreColor } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { renderPlanAction } from "@/app/actions";
import { formatDuration, formatTimecode, relativeTime } from "@/lib/utils";
import { productionPriority } from "@/lib/whop/qualify";

export const dynamic = "force-dynamic";

type Cut = { start: number; end: number; note?: string; zoom?: number };

export default async function MontageQueuePage() {
  const [rushes, pendingPlans, recentClips] = await Promise.all([
    prisma.rush.findMany({
      where: { transcriptStatus: "DONE" },
      include: {
        client: true,
        _count: { select: { editPlans: true, clips: true, moments: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.editPlan.findMany({
      where: { status: { in: ["DRAFT", "FAILED"] } },
      orderBy: { createdAt: "desc" },
      include: { rush: { include: { client: true } } },
    }),
    prisma.clip.findMany({
      // Tout ce qui est rendu, y compris déjà programmé : cette liste sert
      // à retrouver un clip récent, pas à filtrer ce qui reste à faire.
      where: { status: { in: ["READY", "APPROVED", "SCHEDULED", "PUBLISHED"] } },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { rush: true, client: true },
    }),
  ]);

  // File de travail : les rushes classés par priorité du client.
  const queue = rushes
    .map((r) => {
      const prio = r.client
        ? productionPriority({
            score: r.client.score,
            clipsPerMonth: r.client.clipsPerMonth,
            clipsDelivered: r.client.clipsDelivered,
            mrrCents: r.client.mrrCents,
            nextDueAt: r.dueAt,
            status: r.client.status,
          })
        : { priority: 10, reason: "Rush sans client rattaché." };
      return { rush: r, prio };
    })
    .sort((a, b) => b.prio.priority - a.prio.priority);

  const toEdit = queue.filter((q) => q.rush._count.editPlans === 0);

  return (
    <>
      <PageHeader
        stage="Étage 3 · Montage"
        title="Ma file de montage"
        description="Ce qu'il reste à monter, classé par urgence client : retard d'échéance d'abord, puis quota restant, valeur de l'abonnement et qualité du dossier. Le montage lui-même se fait avec Claude, rush par rush."
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="Rushes à monter" value={toEdit.length} sub="aucun plan enregistré" accent={toEdit.length ? "#fbbf24" : "#4ade80"} />
        <Stat label="Plans en attente de rendu" value={pendingPlans.filter((p) => p.status === "DRAFT").length} />
        <Stat label="Rendus en échec" value={pendingPlans.filter((p) => p.status === "FAILED").length} accent={pendingPlans.some((p) => p.status === "FAILED") ? "#f87171" : undefined} />
        <Stat label="Clips prêts" value={recentClips.length} sub="à valider ou programmer" />
      </div>

      {/* ── Plans en attente ─────────────────────────────── */}
      {pendingPlans.length > 0 ? (
        <section style={{ marginBottom: "1.6rem" }}>
          <h2 style={{ fontSize: "1rem", fontWeight: 620, margin: "0 0 0.8rem" }}>Plans à rendre</h2>
          <div style={{ display: "grid", gap: "0.7rem" }}>
            {pendingPlans.map((p) => {
              const cuts = (p.cuts as unknown as Cut[]) ?? [];
              const total = cuts.reduce((s, c) => s + (c.end - c.start), 0);
              return (
                <div key={p.id} className="card" style={{ padding: "0.9rem 1.1rem", display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "1rem", alignItems: "center" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.25rem" }}>
                      <StatusBadge status={p.status} />
                      <span className="badge mono">{cuts.length} coupe(s)</span>
                      <span className="badge mono">{total.toFixed(1)} s</span>
                      <span className="badge">{p.author ?? p.source}</span>
                    </div>
                    <div style={{ fontWeight: 550, fontSize: "0.88rem" }}>{p.title}</div>
                    <div style={{ fontSize: "0.73rem", color: "var(--text-faint)" }}>
                      {p.rush.title}
                      {p.rush.client ? ` · ${p.rush.client.name}` : ""} · {relativeTime(p.createdAt)}
                    </div>
                    {p.error ? <div style={{ fontSize: "0.76rem", color: "#f87171", marginTop: "0.3rem" }}>{p.error}</div> : null}
                  </div>
                  <div style={{ display: "flex", gap: "0.45rem" }}>
                    <Link href={`/rushes/${p.rushId}/montage`} className="btn">Ouvrir</Link>
                    <form action={renderPlanAction}>
                      <input type="hidden" name="planId" value={p.id} />
                      <SubmitButton className="btn-primary" pendingLabel="Rendu…">
                        {p.status === "FAILED" ? "Réessayer" : "Rendre"}
                      </SubmitButton>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ── File de rushes ───────────────────────────────── */}
      <h2 style={{ fontSize: "1rem", fontWeight: 620, margin: "0 0 0.8rem" }}>Rushes prêts à monter</h2>
      {queue.length === 0 ? (
        <Empty title="Rien à monter" hint="Importez un rush et lancez sa transcription." />
      ) : (
        <section className="card" style={{ overflow: "hidden", marginBottom: "1.6rem" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Rush</th>
                <th>Client</th>
                <th style={{ width: "13rem" }}>Priorité</th>
                <th>Durée</th>
                <th>Moments</th>
                <th>Montages</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {queue.map(({ rush, prio }) => (
                <tr key={rush.id}>
                  <td>
                    <Link href={`/rushes/${rush.id}`} style={{ fontWeight: 550 }}>{rush.title}</Link>
                    <div style={{ fontSize: "0.72rem", color: "var(--text-faint)" }}>
                      {rush.origin === "CLIENT_UPLOAD" ? "fourni par le client" : "sourcé par moi"}
                      {rush.dueAt ? ` · échéance ${new Date(rush.dueAt).toLocaleDateString("fr-FR")}` : ""}
                    </div>
                  </td>
                  <td style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{rush.client?.name ?? "—"}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <Meter value={prio.priority} />
                      <span className="mono" style={{ fontSize: "0.76rem", color: scoreColor(prio.priority) }}>{prio.priority}</span>
                    </div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", marginTop: "0.2rem" }}>{prio.reason}</div>
                  </td>
                  <td className="mono">{formatDuration(rush.durationSec)}</td>
                  <td className="mono">{rush._count.moments}</td>
                  <td className="mono">{rush._count.editPlans}</td>
                  <td>
                    <Link href={`/rushes/${rush.id}/montage`} className={rush._count.editPlans === 0 ? "btn btn-primary" : "btn"}>
                      {rush._count.editPlans === 0 ? "Monter" : "Continuer"}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ── Derniers clips ───────────────────────────────── */}
      {recentClips.length ? (
        <>
          <h2 style={{ fontSize: "1rem", fontWeight: 620, margin: "0 0 0.8rem" }}>Derniers clips rendus</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "1rem" }}>
            {recentClips.map((c) => (
              <Link key={c.id} href={`/clips/${c.id}`} className="card" style={{ overflow: "hidden", display: "block" }}>
                <div style={{ aspectRatio: "9/16", background: "#000", position: "relative" }}>
                  {c.previewPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/api/media/clips/${c.id}.jpg`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : null}
                  <div style={{ position: "absolute", top: 8, left: 8 }}><StatusBadge status={c.status} /></div>
                  <div style={{ position: "absolute", bottom: 8, right: 8 }} className="badge mono">{formatDuration(c.durationSec)}</div>
                </div>
                <div style={{ padding: "0.7rem 0.8rem" }}>
                  <div style={{ fontSize: "0.83rem", fontWeight: 550, lineHeight: 1.35 }}>{c.title}</div>
                  <div style={{ fontSize: "0.71rem", color: "var(--text-faint)", marginTop: "0.3rem" }}>
                    {c.client?.name ?? c.rush.title} · {relativeTime(c.createdAt)}
                  </div>
                  {c.cutsSummary ? (
                    <div style={{ fontSize: "0.68rem", color: "var(--text-faint)", marginTop: "0.25rem" }} className="mono">
                      {((c.cutsSummary as unknown as Cut[]) ?? []).length} coupe(s) ·{" "}
                      {((c.cutsSummary as unknown as Cut[]) ?? [])
                        .slice(0, 2)
                        .map((x) => formatTimecode(x.start))
                        .join(", ")}
                    </div>
                  ) : null}
                </div>
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
