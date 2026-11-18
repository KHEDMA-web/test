import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, ScorePill, Empty, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { reviewClipAction, schedulePublicationAction } from "@/app/actions";
import { formatDuration, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const [pending, approved, recent] = await Promise.all([
    prisma.clip.findMany({
      where: { status: "READY" },
      orderBy: { createdAt: "desc" },
      include: { rush: true, client: true, moment: true, editPlan: true },
    }),
    prisma.clip.findMany({
      where: { status: "APPROVED" },
      orderBy: { approvedAt: "desc" },
      include: { client: true, editPlan: true },
    }),
    prisma.clipReview.findMany({ orderBy: { createdAt: "desc" }, take: 8, include: { clip: true } }),
  ]);

  const defaultWhen = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16);

  return (
    <>
      <PageHeader
        stage="Étage 4 · Validation"
        title="File de validation"
        description="Ma relecture avant mise en ligne. Un clip validé compte dans le quota du mois du client et devient publiable ; sinon je repasse par le montage."
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="En attente" value={pending.length} accent={pending.length ? "#fbbf24" : undefined} />
        <Stat label="Validés, non programmés" value={approved.length} accent="#4ade80" />
        <Stat label="Décisions récentes" value={recent.length} />
      </div>

      <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: "0 0 0.8rem" }}>À traiter</h2>
      {pending.length === 0 ? (
        <Empty title="Rien à valider" hint="Les brouillons rendus et les versions déposées par les clippers arrivent ici." />
      ) : (
        <div style={{ display: "grid", gap: "1rem", marginBottom: "1.8rem" }}>
          {pending.map((c) => (
            <article key={c.id} className="card" style={{ display: "grid", gridTemplateColumns: "116px minmax(0,1fr) 15rem", gap: "1.1rem", padding: "1rem", alignItems: "start" }}>
              <Link href={`/clips/${c.id}`} style={{ display: "block", aspectRatio: "9/16", background: "#000", borderRadius: 8, overflow: "hidden" }}>
                {c.previewPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/media/clips/${c.id}.jpg`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : null}
              </Link>

              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", marginBottom: "0.4rem", flexWrap: "wrap" }}>
                  <StatusBadge status={c.status} />
                  <span className="badge">{c.editPlan?.author ?? "montage"}</span>
                  {c.qaScore !== null ? <ScorePill score={c.qaScore} label="QA" /> : null}
                  {c.moment ? <ScorePill score={c.moment.score} label="moment" /> : null}
                </div>
                <Link href={`/clips/${c.id}`} style={{ fontSize: "0.95rem", fontWeight: 600 }}>{c.title}</Link>
                <div style={{ fontSize: "0.76rem", color: "var(--text-faint)", margin: "0.3rem 0 0.6rem" }}>
                  {c.rush.title} · {formatDuration(c.durationSec)} · {c.client?.name ?? "sans client"} · {relativeTime(c.createdAt)}
                </div>
                {c.qaIssues.length ? (
                  <ul style={{ margin: "0 0 0.6rem", paddingLeft: "1.1rem", fontSize: "0.76rem", color: "#fbbf24" }}>
                    {c.qaIssues.map((i) => <li key={i}>{i}</li>)}
                  </ul>
                ) : null}
                <form action={reviewClipAction} style={{ display: "grid", gap: "0.5rem" }}>
                  <input type="hidden" name="clipId" value={c.id} />
                  <input className="input" name="comment" placeholder="Commentaire (facultatif)" />
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button type="submit" name="decision" value="APPROVED" className="btn btn-ok">Valider</button>
                    <button type="submit" name="decision" value="CHANGES_REQUESTED" className="btn">À remonter</button>
                    <button type="submit" name="decision" value="REJECTED" className="btn btn-danger">Refuser</button>
                  </div>
                </form>
              </div>

              <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", marginBottom: "0.4rem" }}>
                  Hook affiché
                </div>
                <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--text)" }}>{c.editPlan?.hook ?? c.caption ?? "—"}</p>
                {c.client?.hookGuidelines ? (
                  <p style={{ marginTop: "0.6rem", fontSize: "0.73rem", color: "var(--text-faint)", lineHeight: 1.5 }}>
                    Consigne : {c.client.hookGuidelines.slice(0, 160)}…
                  </p>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: "0 0 0.8rem" }}>Validés, prêts à programmer</h2>
      {approved.length === 0 ? (
        <Empty title="Aucun clip validé en attente" hint="Les clips validés apparaissent ici jusqu'à leur mise en file." />
      ) : (
        <section className="card" style={{ overflow: "hidden" }}>
          <table className="data">
            <thead>
              <tr><th>Clip</th><th>Campagne</th><th>Durée</th><th style={{ width: "26rem" }}>Programmer</th></tr>
            </thead>
            <tbody>
              {approved.map((c) => (
                <tr key={c.id}>
                  <td><Link href={`/clips/${c.id}`} style={{ fontWeight: 500 }}>{c.title}</Link></td>
                  <td style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{c.client?.name ?? "—"}</td>
                  <td className="mono">{formatDuration(c.durationSec)}</td>
                  <td>
                    <form action={schedulePublicationAction} style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                      <input type="hidden" name="clipId" value={c.id} />
                      {(c.client?.targetNetworks.length ? c.client.targetNetworks : ["instagram", "tiktok"]).map((n) => (
                        <input key={n} type="hidden" name="networks" value={n} />
                      ))}
                      <input className="input" style={{ width: "13rem" }} type="datetime-local" name="scheduledAt" defaultValue={defaultWhen} />
                      <SubmitButton className="btn-primary" pendingLabel="…">Mettre en file</SubmitButton>
                      <span style={{ fontSize: "0.72rem", color: "var(--text-faint)" }}>
                        {(c.client?.targetNetworks.length ? c.client.targetNetworks : ["instagram", "tiktok"]).join(", ")}
                      </span>
                    </form>
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
