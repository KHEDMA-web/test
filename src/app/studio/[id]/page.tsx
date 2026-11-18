import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, ScorePill, Empty, ScoreBreakdown, type Criterion } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { reviewClipAction, uploadClipperVersionAction, schedulePublicationAction, renderDraftAction } from "@/app/actions";
import { formatDuration, formatTimecode, formatDateTime, formatCompact } from "@/lib/utils";
import path from "node:path";
import { STORAGE_ROOT } from "@/lib/storage";

export const dynamic = "force-dynamic";

const NETWORKS = ["instagram", "tiktok", "youtube", "facebook", "linkedin", "twitter"] as const;

/** Chemin disque → URL servie par /api/media. */
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
      moment: { include: { hooks: { orderBy: { score: "desc" } } } },
      hook: true,
      clipper: true,
      campaign: true,
      reviews: { orderBy: { createdAt: "desc" }, include: { reviewer: true } },
      publications: { orderBy: { scheduledAt: "asc" } },
    },
  });
  if (!clip) notFound();

  const [versions, clippers] = await Promise.all([
    prisma.clip.findMany({
      where: { momentId: clip.momentId ?? "none" },
      orderBy: { version: "asc" },
      select: { id: true, version: true, origin: true, status: true, qaScore: true, createdAt: true },
    }),
    prisma.clipperProfile.findMany({ where: { blocked: false }, include: { user: true }, orderBy: { score: "desc" } }),
  ]);

  const video = mediaUrl(clip.filePath);
  const recipe = clip.renderRecipe as Record<string, unknown> | null;
  const momentBd = clip.moment?.scoreBreakdown as unknown as { criteria: Criterion[]; penalties: Criterion[] } | null;
  const defaultWhen = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16);

  return (
    <>
      <PageHeader
        stage="Étage 4 · Montage"
        title={clip.title}
        description={`${clip.origin === "AUTO" ? "Brouillon automatique" : `Version ${clip.version} déposée par le clipper`} · ${formatDuration(clip.durationSec)} · ${clip.width ?? "?"}×${clip.height ?? "?"} · rush : ${clip.rush.title}`}
        actions={<Link href="/studio" className="btn">← Tous les clips</Link>}
      />

      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0, 1fr)", gap: "1.5rem", alignItems: "start" }}>
        {/* ── Lecteur ───────────────────────────────────── */}
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

          <div className="card" style={{ padding: "0.9rem 1rem", display: "grid", gap: "0.55rem", fontSize: "0.8rem" }}>
            <Row label="Statut"><StatusBadge status={clip.status} /></Row>
            <Row label="QA">{clip.qaScore !== null ? <ScorePill score={clip.qaScore} /> : "—"}</Row>
            <Row label="Hook">{clip.hook?.text ?? "—"}</Row>
            <Row label="Extrait">
              <span className="mono">
                {clip.startSec !== null ? `${formatTimecode(clip.startSec)} → ${formatTimecode(clip.endSec ?? 0)}` : "—"}
              </span>
            </Row>
            <Row label="Clipper">{clip.clipper?.name ?? "non attribué"}</Row>
            <Row label="Vues">{clip.views ? formatCompact(clip.views) : "—"}</Row>
            <Row label="Poids">{clip.sizeBytes ? `${(Number(clip.sizeBytes) / 1e6).toFixed(1)} Mo` : "—"}</Row>
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
          {/* ── Validation ─────────────────────────────── */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.8rem", fontSize: "0.9rem", fontWeight: 600 }}>Validation</h2>
            <form action={reviewClipAction} style={{ display: "grid", gap: "0.7rem" }}>
              <input type="hidden" name="clipId" value={clip.id} />
              <textarea className="textarea" name="comment" rows={2} placeholder="Commentaire pour le clipper (facultatif)" />
              <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                <button type="submit" name="decision" value="APPROVED" className="btn btn-ok">Valider</button>
                <button type="submit" name="decision" value="CHANGES_REQUESTED" className="btn">Demander des corrections</button>
                <button type="submit" name="decision" value="REJECTED" className="btn btn-danger">Refuser</button>
              </div>
            </form>

            {clip.reviews.length ? (
              <div style={{ marginTop: "1rem", display: "grid", gap: "0.5rem" }}>
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

          {/* ── Version clipper ────────────────────────── */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.3rem", fontSize: "0.9rem", fontWeight: 600 }}>Déposer une version montée à la main</h2>
            <p style={{ margin: "0 0 0.9rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
              Le fichier déposé crée une nouvelle révision. Le brouillon automatique reste consultable comme référence.
            </p>
            <form action={uploadClipperVersionAction} style={{ display: "grid", gap: "0.6rem" }}>
              <input type="hidden" name="baseClipId" value={clip.id} />
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "0.6rem" }}>
                <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Clipper
                  <select className="select" name="clipperId" defaultValue={clip.clipperId ?? clippers[0]?.userId ?? ""} required>
                    {clippers.map((c) => (
                      <option key={c.id} value={c.userId}>{c.user.name} — {c.tier}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Fichier monté (mp4)
                  <input className="input" type="file" name="file" accept="video/*" required />
                </label>
              </div>
              <input className="input" name="caption" placeholder="Légende (facultatif)" defaultValue={clip.caption ?? ""} />
              <div>
                <SubmitButton className="btn-primary" pendingLabel="Analyse du fichier…">Déposer la version</SubmitButton>
              </div>
            </form>

            {versions.length > 1 ? (
              <div style={{ marginTop: "1rem" }}>
                <div style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", marginBottom: "0.4rem" }}>
                  Révisions
                </div>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                  {versions.map((v) => (
                    <Link
                      key={v.id}
                      href={`/studio/${v.id}`}
                      className="badge"
                      style={v.id === clip.id ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}
                    >
                      v{v.version} · {v.origin === "AUTO" ? "auto" : "clipper"} · QA {v.qaScore ?? "–"}
                    </Link>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          {/* ── Publication ────────────────────────────── */}
          <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
            <h2 style={{ margin: "0 0 0.3rem", fontSize: "0.9rem", fontWeight: 600 }}>Programmer la publication</h2>
            <p style={{ margin: "0 0 0.9rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
              Une publication par réseau est mise en file, décalée de quelques minutes, puis envoyée à Metricool.
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
                      defaultChecked={clip.campaign?.targetNetworks.includes(n) ?? ["instagram", "tiktok"].includes(n)}
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
                  <input className="input" name="text" defaultValue={clip.caption ?? clip.hook?.text ?? clip.title} />
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
                      <td className="mono" style={{ fontSize: "0.76rem" }}>{p.scheduledAtLocal} <span style={{ color: "var(--text-faint)" }}>{p.timezone}</span></td>
                      <td><StatusBadge status={p.status} /></td>
                      <td className="mono" style={{ fontSize: "0.74rem", color: "var(--text-faint)" }}>{p.metricoolPostId ?? "—"}</td>
                      <td style={{ fontSize: "0.74rem", color: "#f87171" }}>{p.lastError ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </section>

          {/* ── Recette et moment ──────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "1.2rem" }}>
            <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
              <h2 style={{ margin: "0 0 0.7rem", fontSize: "0.9rem", fontWeight: 600 }}>Recette de rendu</h2>
              {recipe ? (
                <div style={{ display: "grid", gap: "0.35rem", fontSize: "0.78rem" }}>
                  {Object.entries(recipe)
                    .filter(([k]) => k !== "command")
                    .map(([k, v]) => (
                      <Row key={k} label={k}>
                        <span className="mono" style={{ fontSize: "0.74rem" }}>{String(v)}</span>
                      </Row>
                    ))}
                  {typeof recipe.command === "string" ? (
                    <details style={{ marginTop: "0.5rem" }}>
                      <summary style={{ cursor: "pointer", fontSize: "0.75rem", color: "var(--text-muted)" }}>Commande FFmpeg</summary>
                      <pre className="mono" style={{ fontSize: "0.68rem", whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-faint)", marginTop: "0.5rem" }}>
                        {recipe.command}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : (
                <Empty title="Pas de recette" hint="Ce clip n'a pas été rendu par la plateforme." />
              )}
            </section>

            <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
              <h2 style={{ margin: "0 0 0.7rem", fontSize: "0.9rem", fontWeight: 600 }}>Pourquoi ce moment</h2>
              {clip.moment ? (
                <>
                  <p style={{ margin: "0 0 0.8rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>{clip.moment.rationale}</p>
                  {momentBd?.criteria ? <ScoreBreakdown criteria={momentBd.criteria} penalties={momentBd.penalties} /> : null}
                  <div style={{ marginTop: "0.9rem" }}>
                    <Link href={`/rushes/${clip.rushId}#moment-${clip.moment.id}`} className="btn">Voir dans le rush</Link>
                  </div>
                </>
              ) : (
                <Empty title="Clip hors moment" />
              )}
            </section>
          </div>

          {/* ── Autres hooks ───────────────────────────── */}
          {clip.moment?.hooks.length ? (
            <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
              <h2 style={{ margin: "0 0 0.7rem", fontSize: "0.9rem", fontWeight: 600 }}>Refaire le rendu avec un autre hook</h2>
              <div style={{ display: "grid", gap: "0.4rem" }}>
                {clip.moment.hooks.slice(0, 6).map((h) => (
                  <form key={h.id} action={renderDraftAction} style={{ display: "flex", gap: "0.7rem", alignItems: "center" }}>
                    <input type="hidden" name="momentId" value={clip.momentId ?? ""} />
                    <input type="hidden" name="hookId" value={h.id} />
                    <span style={{ flex: 1, fontSize: "0.82rem" }}>{h.text}</span>
                    <ScorePill score={h.score} />
                    <SubmitButton pendingLabel="Rendu…">Rendre</SubmitButton>
                  </form>
                ))}
              </div>
            </section>
          ) : null}
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
