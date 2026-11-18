import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty, scoreColor, ScorePill } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyButton } from "@/components/CopyButton";
import { buildEditBrief } from "@/lib/pipeline/brief";
import { submitPlanAction, renderPlanAction, deletePlanAction, autoPlanAction } from "@/app/actions";
import { formatDuration, formatTimecode, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Cut = { start: number; end: number; note?: string; zoom?: number };
type Issue = { level: "error" | "warning"; message: string; clipIndex?: number };

export default async function MontagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const rush = await prisma.rush.findUnique({
    where: { id },
    include: {
      client: true,
      moments: { orderBy: { score: "desc" }, include: { hooks: { orderBy: { score: "desc" }, take: 1 } } },
      editPlans: { orderBy: { createdAt: "desc" }, include: { clips: { orderBy: { createdAt: "desc" } } } },
    },
  });
  if (!rush) notFound();

  if (rush.transcriptStatus !== "DONE") {
    return (
      <>
        <PageHeader
          stage="Étage 3 · Montage"
          title={rush.title}
          description="Le rush doit être transcrit avant de pouvoir produire un brief de montage."
          actions={<Link href={`/rushes/${rush.id}`} className="btn">← Analyse du rush</Link>}
        />
        <Empty title="Transcription manquante" hint="Lancez la transcription depuis la page d'analyse du rush." />
      </>
    );
  }

  const brief = await buildEditBrief(rush.id, { clipCount: rush.clipsTarget });
  const duration = rush.durationSec ?? 1;

  // Dernier compte rendu de lecture d'un collage, pour afficher les erreurs.
  const lastParse = await prisma.pipelineEvent.findFirst({
    where: { stage: "plan", entity: `rush:${rush.id}` },
    orderBy: { createdAt: "desc" },
  });
  const parseIssues = ((lastParse?.data as { issues?: Issue[] } | null)?.issues ?? []).filter(
    (i) => i.level === "error" || i.level === "warning",
  );
  const parseNote = (lastParse?.data as { note?: string } | null)?.note;

  return (
    <>
      <PageHeader
        stage="Étage 3 · Montage avec Claude"
        title={rush.title}
        description={`${formatDuration(rush.durationSec)} · ${rush.moments.length} moments repérés · ${rush.editPlans.length} plan(s) de montage${rush.client ? ` · client ${rush.client.name}` : ""}`}
        actions={
          <>
            <Link href={`/rushes/${rush.id}`} className="btn">Analyse</Link>
            <a href={`/api/rushes/${rush.id}/brief`} target="_blank" rel="noreferrer" className="btn">
              Brief brut
            </a>
          </>
        }
      />

      {/* ── 1. Le brief ──────────────────────────────────── */}
      <section className="card" style={{ padding: "1.2rem 1.3rem", marginBottom: "1.3rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: "0 0 0.3rem", fontSize: "1rem", fontWeight: 620 }}>1 · Le brief à donner à Claude</h2>
            <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--text-muted)", maxWidth: "70ch", lineHeight: 1.6 }}>
              Tout ce qu'il faut pour décider d'un montage : le brief du client, la transcription horodatée,
              les moments repérés avec leur score, les hooks candidats, et le format exact de réponse attendu.
              Copiez, collez dans une conversation avec Claude, récupérez sa réponse plus bas.
            </p>
          </div>
          <CopyButton className="btn-primary" text={brief.markdown} label="Copier le brief" copiedLabel="Brief copié" />
        </div>

        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.9rem", flexWrap: "wrap" }}>
          <span className="badge mono">{(brief.approxChars / 1000).toFixed(1)} k caractères</span>
          <span className="badge mono">{brief.segmentCount} segments</span>
          <span className="badge mono">{brief.momentCount} moments</span>
          <span className="badge mono">{rush.clipsTarget} clip(s) demandés</span>
          {rush.client ? <span className="badge">{rush.client.minClipSeconds}–{rush.client.maxClipSeconds} s</span> : null}
        </div>

        <details style={{ marginTop: "0.9rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.82rem", color: "var(--text-muted)" }}>
            Relire le brief avant de l'envoyer
          </summary>
          <pre
            className="mono"
            style={{
              marginTop: "0.7rem",
              padding: "0.9rem",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 9,
              fontSize: "0.72rem",
              lineHeight: 1.6,
              whiteSpace: "pre-wrap",
              maxHeight: "28rem",
              overflowY: "auto",
            }}
          >
            {brief.markdown}
          </pre>
        </details>
      </section>

      {/* ── 2. Le retour de Claude ───────────────────────── */}
      <section className="card" style={{ padding: "1.2rem 1.3rem", marginBottom: "1.3rem" }}>
        <h2 style={{ margin: "0 0 0.3rem", fontSize: "1rem", fontWeight: 620 }}>2 · Coller la réponse de Claude</h2>
        <p style={{ margin: "0 0 0.9rem", fontSize: "0.82rem", color: "var(--text-muted)", maxWidth: "70ch", lineHeight: 1.6 }}>
          Collez la réponse entière, le texte autour du JSON ne gêne pas. Les timecodes sont vérifiés contre
          le rush et recalés sur la parole pour ne pas couper au milieu d'un mot.
        </p>

        <form action={submitPlanAction} style={{ display: "grid", gap: "0.7rem" }}>
          <input type="hidden" name="rushId" value={rush.id} />
          <textarea
            className="textarea mono"
            name="plan"
            rows={10}
            placeholder={'{\n  "version": "clipflow-plan-1",\n  "clips": [ … ]\n}'}
            style={{ fontSize: "0.78rem", lineHeight: 1.5 }}
          />
          <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: "0.4rem", alignItems: "center", fontSize: "0.82rem" }}>
              <input type="checkbox" name="renderNow" defaultChecked />
              Rendre les clips tout de suite
            </label>
            <SubmitButton className="btn-primary" pendingLabel="Lecture et rendu…">
              Enregistrer le montage
            </SubmitButton>
          </div>
        </form>

        {parseIssues.length > 0 || parseNote ? (
          <div
            style={{
              marginTop: "1rem",
              padding: "0.8rem 0.9rem",
              borderRadius: 9,
              border: `1px solid ${parseIssues.some((i) => i.level === "error") ? "#ef444455" : "#f59e0b44"}`,
              background: parseIssues.some((i) => i.level === "error") ? "#ef44440d" : "#f59e0b0d",
            }}
          >
            <div style={{ fontSize: "0.74rem", fontWeight: 600, marginBottom: "0.45rem", color: "var(--text-muted)" }}>
              Dernière lecture — {relativeTime(lastParse!.createdAt)}
            </div>
            {parseNote ? (
              <p style={{ margin: "0 0 0.5rem", fontSize: "0.82rem", fontStyle: "italic" }}>Note de Claude : {parseNote}</p>
            ) : null}
            <ul style={{ margin: 0, paddingLeft: "1.1rem", display: "grid", gap: "0.25rem" }}>
              {parseIssues.map((i, n) => (
                <li key={n} style={{ fontSize: "0.8rem", color: i.level === "error" ? "#f87171" : "#fbbf24" }}>
                  {i.clipIndex !== undefined ? `Clip ${i.clipIndex + 1} — ` : ""}
                  {i.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* ── 3. Les plans ─────────────────────────────────── */}
      <h2 style={{ fontSize: "1rem", fontWeight: 620, margin: "0 0 0.8rem" }}>
        3 · Montages{rush.editPlans.length ? ` (${rush.editPlans.length})` : ""}
      </h2>

      {rush.editPlans.length === 0 ? (
        <Empty
          title="Aucun montage pour l'instant"
          hint="Copiez le brief, donnez-le à Claude, collez sa réponse ci-dessus."
        />
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {rush.editPlans.map((plan) => {
            const cuts = (plan.cuts as unknown as Cut[]) ?? [];
            const total = cuts.reduce((s, c) => s + (c.end - c.start), 0);
            const clip = plan.clips[0];
            return (
              <article key={plan.id} className="card" style={{ padding: "1.1rem 1.2rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "0.8rem" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.35rem" }}>
                      <StatusBadge status={plan.status} />
                      <span className="badge">{plan.source === "CLAUDE_CHAT" ? "Claude (chat)" : plan.source === "CLAUDE_CODE" ? "Claude Code" : plan.source === "AUTO" ? "auto" : "manuel"}</span>
                      <span className="badge mono">{cuts.length} coupe(s)</span>
                      <span className="badge mono">{total.toFixed(1)} s</span>
                      <span className="badge">{plan.framing}</span>
                      {clip?.qaScore !== null && clip?.qaScore !== undefined ? <ScorePill score={clip.qaScore} label="QA" /> : null}
                    </div>
                    <h3 style={{ margin: "0 0 0.2rem", fontSize: "0.98rem", fontWeight: 600 }}>{plan.title}</h3>
                    {plan.hook ? (
                      <p style={{ margin: 0, fontSize: "0.86rem", color: "var(--accent)" }}>
                        Hook : « {plan.hook} » <span style={{ color: "var(--text-faint)" }}>({plan.hook.length} car.)</span>
                      </p>
                    ) : null}
                  </div>

                  <div style={{ display: "flex", gap: "0.45rem", flexWrap: "wrap" }}>
                    {clip ? <Link href={`/clips/${clip.id}`} className="btn">Voir le clip</Link> : null}
                    <form action={renderPlanAction}>
                      <input type="hidden" name="planId" value={plan.id} />
                      <SubmitButton className={clip ? "" : "btn-primary"} pendingLabel="Rendu FFmpeg…">
                        {clip ? "Refaire le rendu" : "Rendre"}
                      </SubmitButton>
                    </form>
                    <form action={deletePlanAction}>
                      <input type="hidden" name="planId" value={plan.id} />
                      <SubmitButton className="btn-danger" pendingLabel="…">Supprimer</SubmitButton>
                    </form>
                  </div>
                </div>

                {/* Les coupes, placées sur la durée du rush */}
                <div style={{ position: "relative", height: 34, background: "var(--bg-subtle)", borderRadius: 7, border: "1px solid var(--border)", overflow: "hidden", marginBottom: "0.6rem" }}>
                  {cuts.map((c, i) => (
                    <div
                      key={i}
                      title={`${formatTimecode(c.start)} → ${formatTimecode(c.end)}${c.note ? ` · ${c.note}` : ""}`}
                      style={{
                        position: "absolute",
                        left: `${(c.start / duration) * 100}%`,
                        width: `${Math.max(0.6, ((c.end - c.start) / duration) * 100)}%`,
                        top: 5,
                        bottom: 5,
                        background: "var(--accent-soft)",
                        border: "1px solid var(--accent)",
                        borderRadius: 4,
                        display: "grid",
                        placeItems: "center",
                        fontSize: "0.65rem",
                        color: "var(--accent)",
                      }}
                      className="mono"
                    >
                      {i + 1}
                    </div>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: clip ? "150px minmax(0,1fr)" : "minmax(0,1fr)", gap: "1.1rem" }}>
                  {clip ? (
                    <Link href={`/clips/${clip.id}`} style={{ display: "block", aspectRatio: "9/16", background: "#000", borderRadius: 8, overflow: "hidden" }}>
                      {clip.previewPath ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/api/media/clips/${clip.id}.jpg`} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : null}
                    </Link>
                  ) : null}

                  <div>
                    <ol style={{ margin: "0 0 0.7rem", paddingLeft: "1.1rem", display: "grid", gap: "0.2rem" }}>
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

                    {plan.rationale ? (
                      <p style={{ margin: "0 0 0.6rem", fontSize: "0.82rem", lineHeight: 1.6, color: "var(--text-muted)", fontStyle: "italic" }}>
                        {plan.rationale}
                      </p>
                    ) : null}

                    {plan.warnings.length ? (
                      <ul style={{ margin: "0 0 0.5rem", paddingLeft: "1.1rem" }}>
                        {plan.warnings.map((w, i) => (
                          <li key={i} style={{ fontSize: "0.76rem", color: "#fbbf24" }}>{w}</li>
                        ))}
                      </ul>
                    ) : null}

                    {plan.error ? (
                      <p style={{ margin: 0, fontSize: "0.78rem", color: "#f87171" }}>Rendu en échec : {plan.error}</p>
                    ) : null}

                    <div style={{ fontSize: "0.72rem", color: "var(--text-faint)", marginTop: "0.4rem" }}>
                      {plan.author ?? "—"} · {relativeTime(plan.createdAt)}
                      {plan.musicNote ? ` · musique : ${plan.musicNote}` : ""}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ── 4. Repli automatique ─────────────────────────── */}
      {rush.moments.length ? (
        <details className="card" style={{ marginTop: "1.3rem", padding: "1rem 1.2rem" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.88rem", fontWeight: 600 }}>
            Dégrossir sans Claude : une coupe par moment repéré
          </summary>
          <p style={{ margin: "0.6rem 0 0.8rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
            Extrait brut du moment avec son meilleur hook, sans travail éditorial. Utile pour voir vite ce que
            donne un passage, pas pour livrer.
          </p>
          <div style={{ display: "grid", gap: "0.45rem" }}>
            {rush.moments.slice(0, 6).map((m) => (
              <form key={m.id} action={autoPlanAction} style={{ display: "flex", gap: "0.7rem", alignItems: "center" }}>
                <input type="hidden" name="momentId" value={m.id} />
                <span className="mono" style={{ fontSize: "0.76rem", color: "var(--text-faint)", minWidth: "8rem" }}>
                  {formatTimecode(m.startSec)} → {formatTimecode(m.endSec)}
                </span>
                <span style={{ flex: 1, fontSize: "0.8rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {m.hooks[0]?.text ?? m.transcript.slice(0, 70)}
                </span>
                <span className="mono" style={{ fontSize: "0.75rem", color: scoreColor(m.score) }}>{m.score}</span>
                <SubmitButton pendingLabel="Rendu…">Extraire</SubmitButton>
              </form>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
}
