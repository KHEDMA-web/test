import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, ScorePill, Meter, ScoreBreakdown, Empty, scoreColor, type Criterion } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { transcribeRushAction, detectMomentsAction, selectHookAction } from "@/app/actions";
import { formatDuration, formatTimecode } from "@/lib/utils";

export const dynamic = "force-dynamic";

type MomentBreakdown = { criteria: Criterion[]; penalties: Criterion[] };
type HookBreakdown = { components: Criterion[]; total: number };

export default async function RushDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const rush = await prisma.rush.findUnique({
    where: { id },
    include: {
      client: true,
      segments: { orderBy: { idx: "asc" } },
      moments: { orderBy: { startSec: "asc" }, include: { hooks: { orderBy: { score: "desc" } }, clips: true } },
    },
  });
  if (!rush) notFound();

  const duration = rush.durationSec ?? Math.max(...rush.segments.map((s) => s.endSec), 1);
  const topMoment = [...rush.moments].sort((a, b) => b.score - a.score)[0];

  return (
    <>
      <PageHeader
        stage="Étage 2 · Analyse du rush"
        title={rush.title}
        description={`${formatDuration(rush.durationSec)} · ${rush.width ?? "?"}×${rush.height ?? "?"} · ${rush.segments.length} segments transcrits · ${rush.moments.length} moments repérés${rush.client ? ` · client ${rush.client.name}` : ""}`}
        actions={
          <>
            <form action={transcribeRushAction}>
              <input type="hidden" name="rushId" value={rush.id} />
              <SubmitButton pendingLabel="Transcription…">
                {rush.transcriptStatus === "DONE" ? "Retranscrire" : "Transcrire"}
              </SubmitButton>
            </form>
            <form action={detectMomentsAction}>
              <input type="hidden" name="rushId" value={rush.id} />
              <SubmitButton pendingLabel="Détection…">Détecter les moments</SubmitButton>
            </form>
            {rush.transcriptStatus === "DONE" ? (
              <Link href={`/rushes/${rush.id}/montage`} className="btn btn-primary">
                Monter avec Claude →
              </Link>
            ) : null}
          </>
        }
      />

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.3rem", flexWrap: "wrap" }}>
        <StatusBadge status={rush.status} />
        <span className="badge">transcription : {rush.transcriptStatus.toLowerCase()}</span>
        {rush.transcriptProvider ? <span className="badge">provider : {rush.transcriptProvider}</span> : null}
        {rush.hasAudio ? null : <span className="badge" style={{ color: "#fbbf24" }}>sans piste audio</span>}
        {rush.error ? <span className="badge" style={{ color: "#f87171" }}>{rush.error}</span> : null}
      </div>

      {/* ── Timeline ──────────────────────────────────────── */}
      <section className="card" style={{ padding: "1.2rem 1.3rem", marginBottom: "1.4rem" }}>
        <h2 style={{ margin: "0 0 0.3rem", fontSize: "0.88rem", fontWeight: 600 }}>Carte des moments</h2>
        <p style={{ margin: "0 0 1rem", fontSize: "0.78rem", color: "var(--text-muted)" }}>
          Chaque bloc est un passage candidat, positionné sur la durée du rush. La couleur donne le score de clippabilité.
        </p>
        <div style={{ position: "relative", height: 52, background: "var(--bg-subtle)", borderRadius: 8, border: "1px solid var(--border)", overflow: "hidden" }}>
          {rush.moments.map((m) => {
            const left = (m.startSec / duration) * 100;
            const width = Math.max(0.8, ((m.endSec - m.startSec) / duration) * 100);
            return (
              <a
                key={m.id}
                href={`#moment-${m.id}`}
                title={`${formatTimecode(m.startSec)} → ${formatTimecode(m.endSec)} · score ${m.score}`}
                style={{
                  position: "absolute",
                  left: `${left}%`,
                  width: `${width}%`,
                  top: 6,
                  bottom: 6,
                  background: `${scoreColor(m.score)}33`,
                  border: `1px solid ${scoreColor(m.score)}`,
                  borderRadius: 5,
                  display: "grid",
                  placeItems: "center",
                  fontSize: "0.68rem",
                  fontWeight: 700,
                  color: scoreColor(m.score),
                }}
                className="mono"
              >
                {m.score}
              </a>
            );
          })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.68rem", color: "var(--text-faint)", marginTop: "0.4rem" }} className="mono">
          <span>0:00</span>
          <span>{formatDuration(duration / 2)}</span>
          <span>{formatDuration(duration)}</span>
        </div>
      </section>

      {/* ── Moments ───────────────────────────────────────── */}
      <h2 style={{ fontSize: "1rem", fontWeight: 600, margin: "0 0 0.8rem" }}>
        Moments retenus {topMoment ? <span style={{ color: "var(--text-faint)", fontWeight: 400, fontSize: "0.82rem" }}>— meilleur score {topMoment.score}/100</span> : null}
      </h2>

      {rush.moments.length === 0 ? (
        <Empty title="Aucun moment détecté" hint="Transcrivez le rush, puis lancez la détection." />
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {[...rush.moments].sort((a, b) => b.score - a.score).map((m) => {
            const bd = m.scoreBreakdown as unknown as MomentBreakdown | null;
            return (
              <article key={m.id} id={`moment-${m.id}`} className="card" style={{ padding: "1.1rem 1.2rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", marginBottom: "0.8rem", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.35rem", flexWrap: "wrap" }}>
                      <span className="mono badge">{formatTimecode(m.startSec)} → {formatTimecode(m.endSec)}</span>
                      <span className="badge">{(m.endSec - m.startSec).toFixed(1)} s</span>
                      <ScorePill score={m.score} />
                      <StatusBadge status={m.status} />
                      {m.emotion ? <span className="badge" style={{ color: "var(--stage-3)" }}>{m.emotion}</span> : null}
                    </div>
                    <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-muted)", maxWidth: "70ch" }}>{m.rationale}</p>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    {m.clips.length > 0 ? (
                      <Link href={`/clips/${m.clips[0].id}`} className="btn">Voir le clip</Link>
                    ) : null}
                    <Link href={`/rushes/${rush.id}/montage`} className="btn">Monter ce passage</Link>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr) 15rem", gap: "1.4rem" }}>
                  <div>
                    <h3 style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", margin: "0 0 0.5rem" }}>
                      Transcription du passage
                    </h3>
                    <p style={{ margin: 0, fontSize: "0.84rem", lineHeight: 1.6, color: "var(--text)", maxHeight: "11rem", overflowY: "auto" }}>
                      {m.transcript}
                    </p>
                    {m.keywords.length ? (
                      <div style={{ marginTop: "0.6rem", display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                        {m.keywords.map((k) => <span key={k} className="badge">{k}</span>)}
                      </div>
                    ) : null}
                  </div>

                  <div>
                    <h3 style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", margin: "0 0 0.5rem" }}>
                      Hooks proposés ({m.hooks.length})
                    </h3>
                    <div style={{ display: "grid", gap: "0.4rem", maxHeight: "13rem", overflowY: "auto" }}>
                      {m.hooks.map((h) => {
                        const hb = h.scoreBreakdown as unknown as HookBreakdown | null;
                        return (
                          <form
                            key={h.id}
                            action={selectHookAction}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "minmax(0,1fr) auto",
                              gap: "0.5rem",
                              alignItems: "center",
                              padding: "0.45rem 0.55rem",
                              borderRadius: 8,
                              border: `1px solid ${h.selected ? "var(--accent)" : "var(--border)"}`,
                              background: h.selected ? "var(--accent-soft)" : "transparent",
                            }}
                          >
                            <input type="hidden" name="hookId" value={h.id} />
                            <input type="hidden" name="momentId" value={m.id} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: "0.82rem", fontWeight: h.selected ? 600 : 450 }}>{h.text}</div>
                              <div style={{ fontSize: "0.68rem", color: "var(--text-faint)" }}>
                                {h.style} · {h.text.length} car. · {h.provider}
                                {hb ? ` · brièveté ${hb.components.find((c) => c.key === "brevity")?.points ?? "–"}/20` : ""}
                              </div>
                            </div>
                            <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                              <span className="mono" style={{ fontSize: "0.75rem", color: scoreColor(h.score) }}>{h.score}</span>
                              {h.selected ? (
                                <span className="badge" style={{ color: "var(--accent)" }}>choisi</span>
                              ) : (
                                <SubmitButton pendingLabel="…">Choisir</SubmitButton>
                              )}
                            </div>
                          </form>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <h3 style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", margin: "0 0 0.5rem" }}>
                      Détail du score
                    </h3>
                    {bd?.criteria ? <ScoreBreakdown criteria={bd.criteria} penalties={bd.penalties} /> : <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>—</p>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ── Transcription complète ────────────────────────── */}
      {rush.segments.length > 0 ? (
        <details className="card" style={{ marginTop: "1.4rem", padding: "1rem 1.2rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.88rem", fontWeight: 600 }}>
            Transcription complète ({rush.segments.length} segments)
          </summary>
          <div style={{ marginTop: "0.9rem", display: "grid", gap: "0.35rem", maxHeight: "30rem", overflowY: "auto" }}>
            {rush.segments.map((s) => (
              <div key={s.id} style={{ display: "grid", gridTemplateColumns: "5rem 7rem minmax(0,1fr)", gap: "0.7rem", fontSize: "0.82rem", padding: "0.25rem 0" }}>
                <span className="mono" style={{ color: "var(--text-faint)", fontSize: "0.74rem" }}>{formatTimecode(s.startSec)}</span>
                <span style={{ color: "var(--stage-3)", fontSize: "0.76rem" }}>{s.speaker ?? "—"}</span>
                <span>{s.text}</span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}
