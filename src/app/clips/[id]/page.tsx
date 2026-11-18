import Link from "next/link";
import { notFound } from "next/navigation";
import path from "node:path";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, ScorePill, Empty } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { reviewClipAction, schedulePublicationAction, renderPlanAction, deliverClipAction } from "@/app/actions";
import { formatDuration, formatTimecode, formatDateTime, formatCompact } from "@/lib/utils";
import { STORAGE_ROOT } from "@/lib/storage";

export const dynamic = "force-dynamic";

const NETWORKS = ["instagram", "tiktok", "youtube", "facebook", "linkedin", "twitter"] as const;
type Cut = { start: number; end: number; note?: string; zoom?: number };

function mediaUrl(filePath: string | null): string | null {
  if (!filePath) return null;
  const rel = path.relative(STORAGE_ROOT, filePath).split(path.sep).join("/");
  return rel.startsWith("..") ? null : `/api/media/${rel}`;
}

export default async function ClipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const clip = await prisma.clip.findUnique({
    where: { id },
    include: {
      rush: true,
      client: true,
      editPlan: true,
      moment: true,
      reviews: { orderBy: { createdAt: "desc" } },
      publications: { orderBy: { scheduledAt: "asc" } },
      deliveries: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!clip) notFound();

  const video = mediaUrl(clip.filePath);
  const cuts = (clip.cutsSummary as unknown as Cut[]) ?? [];
  const recipe = clip.renderRecipe as Record<string, unknown> | null;
  const rushDuration = clip.rush.durationSec ?? 1;
  const defaultWhen = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16);

  return (
    <>
      <PageHeader
        stage="Étage 4 · Clip"
        title={clip.title}
        description={`${formatDuration(clip.durationSec)} · ${cuts.length} coupe(s) · ${clip.width ?? "?"}×${clip.height ?? "?"} · rush : ${clip.rush.title}${clip.client ? ` · ${clip.client.name}` : ""}`}
        actions={
          <>
            <Link href={`/rushes/${clip.rushId}/montage`} className="btn">Le montage</Link>
            <Link href="/montage" className="btn">← File</Link>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: "1.5rem", alignItems: "start" }}>
        <div style={{ display: "grid", gap: "1rem", position: "sticky", top: "1rem" }}>
          <div className="card" style={{ overflow: "hidden", background: "#000" }}>
            {video ? (
              <video src={video} controls playsInline style={{ width: "100%", aspectRatio: "9 / 16", display: "block" }} />
            ) : (
              <div style={{ aspectRatio: "9 / 16", display: "grid", placeItems: "center", color: "var(--text-faint)", fontSize: "0.85rem" }}>
                Rendu indisponible
              </div>
            )}
          </div>

          <div className="card" style={{ padding: "0.9rem 1rem", display: "grid", gap: "0.5rem", fontSize: "0.8rem" }}>
            <Row label="Statut"><StatusBadge status={clip.status} /></Row>
            <Row label="QA">{clip.qaScore !== null ? <ScorePill score={clip.qaScore} /> : "—"}</Row>
            <Row label="Hook">{clip.editPlan?.hook ?? "—"}</Row>
            <Row label="Coupes">{cuts.length}</Row>
            <Row label="Vues">{clip.views ? formatCompact(clip.views) : "—"}</Row>
            <Row label="Poids">{clip.sizeBytes ? `${(Number(clip.sizeBytes) / 1e6).toFixed(1)} Mo` : "—"}</Row>
            <Row label="Source du plan">{clip.editPlan?.author ?? "—"}</Row>
          </div>

          {clip.qaIssues.length ? (
            <div className="card" style={{ padding: "0.8rem 1rem", borderColor: "#f59e0b44", background: "#f59e0b0d" }}>
              <div style={{ fontSize: "0.75rem", fontWeight: 600, color: "#fbbf24", marginBottom: "0.4rem" }}>Contrôle qualité</div>
              <ul style={{ margin: 0, paddingLeft: "1.1rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
                {clip.qaIssues.map((i) => <li key={i}>{i}</li>)}
              </ul>
            </div>
          ) : null}
        </div>

        <div style={{ display: "grid", gap: "1.2rem" }}>
          {/* Le montage exécuté */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", marginBottom: "0.8rem" }}>
              <h2 style={{ margin: 0, fontSize: "0.92rem", fontWeight: 600 }}>Le montage</h2>
              {clip.editPlanId ? (
                <form action={renderPlanAction}>
                  <input type="hidden" name="planId" value={clip.editPlanId} />
                  <SubmitButton pendingLabel="Rendu…">Refaire le rendu</SubmitButton>
                </form>
              ) : null}
            </div>

            <div style={{ position: "relative", height: 30, background: "var(--bg-subtle)", borderRadius: 7, border: "1px solid var(--border)", overflow: "hidden", marginBottom: "0.7rem" }}>
              {cuts.map((c, i) => (
                <div
                  key={i}
                  title={`${formatTimecode(c.start)} → ${formatTimecode(c.end)}`}
                  className="mono"
                  style={{
                    position: "absolute",
                    left: `${(c.start / rushDuration) * 100}%`,
                    width: `${Math.max(0.6, ((c.end - c.start) / rushDuration) * 100)}%`,
                    top: 4,
                    bottom: 4,
                    background: "var(--accent-soft)",
                    border: "1px solid var(--accent)",
                    borderRadius: 4,
                    display: "grid",
                    placeItems: "center",
                    fontSize: "0.62rem",
                    color: "var(--accent)",
                  }}
                >
                  {i + 1}
                </div>
              ))}
            </div>

            <ol style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.2rem" }}>
              {cuts.map((c, i) => (
                <li key={i} style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                  <span className="mono" style={{ color: "var(--text)" }}>
                    {formatTimecode(c.start)} → {formatTimecode(c.end)}
                  </span>{" "}
                  <span className="mono" style={{ color: "var(--text-faint)" }}>({(c.end - c.start).toFixed(1)} s{c.zoom ? `, zoom ${c.zoom}` : ""})</span>
                  {c.note ? ` — ${c.note}` : ""}
                </li>
              ))}
            </ol>

            {clip.editPlan?.rationale ? (
              <p style={{ margin: "0.8rem 0 0", fontSize: "0.82rem", lineHeight: 1.6, color: "var(--text-muted)", fontStyle: "italic" }}>
                {clip.editPlan.rationale}
              </p>
            ) : null}
          </section>

          {/* Livraison */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
              <div>
                <h2 style={{ margin: "0 0 0.25rem", fontSize: "0.92rem", fontWeight: 600 }}>Livraison</h2>
                <p style={{ margin: 0, fontSize: "0.78rem", color: "var(--text-muted)" }}>
                  Dépose la vidéo, sa vignette et sa fiche de légende dans le dossier synchronisé.
                </p>
              </div>
              <form action={deliverClipAction}>
                <input type="hidden" name="clipId" value={clip.id} />
                <SubmitButton className={clip.deliveries.some((d) => d.status === "DELIVERED") ? "" : "btn-primary"} pendingLabel="Copie…">
                  {clip.deliveries.some((d) => d.status === "DELIVERED") ? "Redéposer" : "Déposer dans le Drive"}
                </SubmitButton>
              </form>
            </div>

            {clip.deliveries.length ? (
              <table className="data" style={{ marginTop: "0.9rem" }}>
                <thead><tr><th>Fichier</th><th>Statut</th><th>Quand</th></tr></thead>
                <tbody>
                  {clip.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td className="mono" style={{ fontSize: "0.74rem" }}>
                        {d.filePath}
                        {d.error ? <div style={{ color: "#f87171", fontFamily: "var(--font-sans)" }}>{d.error}</div> : null}
                      </td>
                      <td><StatusBadge status={d.status} /></td>
                      <td style={{ fontSize: "0.74rem", color: "var(--text-faint)" }}>{formatDateTime(d.deliveredAt ?? d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>

          {/* Validation */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.8rem", fontSize: "0.92rem", fontWeight: 600 }}>Validation</h2>
            <form action={reviewClipAction} style={{ display: "grid", gap: "0.7rem" }}>
              <input type="hidden" name="clipId" value={clip.id} />
              <textarea className="textarea" name="comment" rows={2} placeholder="Note pour moi-même (facultatif)" />
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button type="submit" name="decision" value="APPROVED" className="btn btn-ok">Valider</button>
                <button type="submit" name="decision" value="CHANGES_REQUESTED" className="btn">À remonter</button>
                <button type="submit" name="decision" value="REJECTED" className="btn btn-danger">Abandonner</button>
              </div>
            </form>
            {clip.reviews.length ? (
              <div style={{ marginTop: "0.9rem", display: "grid", gap: "0.45rem" }}>
                {clip.reviews.map((r) => (
                  <div key={r.id} style={{ fontSize: "0.8rem", display: "flex", gap: "0.6rem", alignItems: "baseline" }}>
                    <StatusBadge status={r.decision} />
                    <span style={{ color: "var(--text-muted)" }}>{r.comment ?? "—"}</span>
                    <span className="mono" style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--text-faint)" }}>
                      {formatDateTime(r.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          {/* Publication */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.3rem", fontSize: "0.92rem", fontWeight: 600 }}>Programmer la publication</h2>
            <p style={{ margin: "0 0 0.9rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
              Une publication par réseau, décalée de quelques minutes, envoyée à Metricool.
            </p>
            <form action={schedulePublicationAction} style={{ display: "grid", gap: "0.7rem" }}>
              <input type="hidden" name="clipId" value={clip.id} />
              <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
                {NETWORKS.map((n) => (
                  <label key={n} style={{ display: "flex", gap: "0.35rem", alignItems: "center", fontSize: "0.8rem" }}>
                    <input
                      type="checkbox"
                      name="networks"
                      value={n}
                      defaultChecked={clip.client?.targetNetworks.includes(n) ?? ["instagram", "tiktok"].includes(n)}
                    />
                    {n}
                  </label>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "14rem minmax(0,1fr) auto", gap: "0.6rem", alignItems: "end" }}>
                <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Date et heure
                  <input className="input" type="datetime-local" name="scheduledAt" defaultValue={defaultWhen} />
                </label>
                <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Texte du post
                  <input className="input" name="text" defaultValue={clip.caption ?? clip.editPlan?.hook ?? clip.title} />
                </label>
                <SubmitButton className="btn-primary" pendingLabel="Mise en file…">Mettre en file</SubmitButton>
              </div>
            </form>

            {clip.publications.length ? (
              <table className="data" style={{ marginTop: "1rem" }}>
                <thead>
                  <tr><th>Réseau</th><th>Planifié</th><th>Statut</th><th>Post Metricool</th><th>Erreur</th></tr>
                </thead>
                <tbody>
                  {clip.publications.map((p) => (
                    <tr key={p.id}>
                      <td>{p.network}</td>
                      <td className="mono" style={{ fontSize: "0.76rem" }}>
                        {p.scheduledAtLocal} <span style={{ color: "var(--text-faint)" }}>{p.timezone}</span>
                      </td>
                      <td><StatusBadge status={p.status} /></td>
                      <td className="mono" style={{ fontSize: "0.73rem", color: "var(--text-faint)" }}>{p.metricoolPostId ?? "—"}</td>
                      <td style={{ fontSize: "0.73rem", color: "#f87171" }}>{p.lastError ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>

          {/* Recette technique */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.7rem", fontSize: "0.92rem", fontWeight: 600 }}>Recette de rendu</h2>
            {recipe ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "0.3rem 1rem", fontSize: "0.78rem" }}>
                {Object.entries(recipe)
                  .filter(([k]) => k !== "command")
                  .map(([k, v]) => (
                    <Row key={k} label={k}>
                      <span className="mono" style={{ fontSize: "0.74rem" }}>{String(v)}</span>
                    </Row>
                  ))}
              </div>
            ) : (
              <Empty title="Pas de recette" />
            )}
            {recipe && typeof recipe.command === "string" ? (
              <details style={{ marginTop: "0.7rem" }}>
                <summary style={{ cursor: "pointer", fontSize: "0.75rem", color: "var(--text-muted)" }}>Commande FFmpeg</summary>
                <pre className="mono" style={{ fontSize: "0.66rem", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-faint)", marginTop: "0.5rem" }}>
                  {recipe.command}
                </pre>
              </details>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.8rem", alignItems: "center" }}>
      <span style={{ color: "var(--text-faint)", fontSize: "0.74rem" }}>{label}</span>
      <span style={{ textAlign: "right", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{children}</span>
    </div>
  );
}
