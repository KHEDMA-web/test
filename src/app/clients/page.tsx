import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, Stat, StatusBadge, ScorePill, Meter, Empty, ScoreBreakdown, scoreColor, type Criterion } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { syncWhopAction, decideClientAction, updateClientBriefAction, resetQuotasAction } from "@/app/actions";
import { formatCents, formatCompact, relativeTime } from "@/lib/utils";
import { productionPriority } from "@/lib/whop/qualify";
import { whop } from "@/lib/whop/client";

export const dynamic = "force-dynamic";

const NETWORKS = ["instagram", "tiktok", "youtube", "facebook", "linkedin", "twitter"] as const;

type Breakdown = {
  score: number;
  components: Criterion[];
  decision: string;
  summary: string;
  pricePerClipCents: number;
};

export default async function ClientsPage() {
  const rows = await prisma.client.findMany({
    include: {
      rushes: { select: { id: true, dueAt: true, status: true }, orderBy: { createdAt: "desc" } },
      clips: { select: { id: true, status: true, views: true } },
    },
  });

  // Les clients qui produisent d'abord, les dossiers à trancher ensuite,
  // les impayés et les refus en bas.
  const STATUS_ORDER: Record<string, number> = {
    ACTIVE: 0,
    TRIAL: 1,
    PROSPECT: 2,
    PAST_DUE: 3,
    PAUSED: 4,
    DECLINED: 5,
    CHURNED: 6,
  };
  const clients = [...rows].sort(
    (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b.score - a.score,
  );

  const active = clients.filter((c) => c.status === "ACTIVE" || c.status === "TRIAL");
  const mrr = active.reduce((s, c) => s + c.mrrCents, 0);
  const prospects = clients.filter((c) => c.status === "PROSPECT");
  const committed = active.reduce((s, c) => s + c.clipsPerMonth, 0);
  const delivered = active.reduce((s, c) => s + c.clipsDelivered, 0);

  return (
    <>
      <PageHeader
        stage="Étage 1 · Whop"
        title="Mes clients"
        description="Les abonnements Whop arrivent ici. La qualification répond à une seule question : ce client vaut-il mon temps ? Le prix par clip tranche — en dessous du seuil de viabilité, le volume demandé coûte plus qu'il ne rapporte, quel que soit le reste du dossier."
        actions={
          <>
            <form action={resetQuotasAction}>
              <SubmitButton pendingLabel="…">Nouvelle période</SubmitButton>
            </form>
            <form action={syncWhopAction}>
              <SubmitButton className="btn-primary" pendingLabel="Synchronisation…">Synchroniser Whop</SubmitButton>
            </form>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="Revenu mensuel" value={formatCents(mrr)} sub={`${active.length} client(s) actifs`} accent="#4ade80" />
        <Stat label="Clips engagés" value={`${delivered} / ${committed}`} sub="livrés ce mois-ci" accent={delivered < committed ? "#fbbf24" : "#4ade80"} />
        <Stat label="À qualifier" value={prospects.length} sub="dossiers en attente" accent={prospects.length ? "#22d3ee" : undefined} />
        <Stat
          label="Prix moyen par clip"
          value={committed ? formatCents(Math.round(mrr / committed)) : "—"}
          sub="sur les engagements en cours"
        />
        <Stat label="API Whop" value={whop.mode() === "live" ? "réelle" : "mock"} sub={`${clients.length} abonnements connus`} />
      </div>

      {clients.length === 0 ? (
        <Empty title="Aucun client" hint="Lancez une synchronisation Whop pour importer les abonnements." />
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          {clients.map((c) => {
            const bd = c.scoreBreakdown as unknown as Breakdown | null;
            const nextDue = c.rushes.find((r) => r.dueAt)?.dueAt ?? null;
            const prio = productionPriority({
              score: c.score,
              clipsPerMonth: c.clipsPerMonth,
              clipsDelivered: c.clipsDelivered,
              mrrCents: c.mrrCents,
              nextDueAt: nextDue,
              status: c.status,
            });
            const views = c.clips.reduce((s, x) => s + x.views, 0);
            const pricePerClip = bd?.pricePerClipCents ?? Math.round(c.mrrCents / Math.max(1, c.clipsPerMonth));

            return (
              <article key={c.id} className="card" style={{ padding: "1.2rem 1.3rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "0.9rem" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: "flex", gap: "0.45rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.3rem" }}>
                      <h2 style={{ margin: 0, fontSize: "1.05rem", fontWeight: 620 }}>{c.name}</h2>
                      <StatusBadge status={c.status} />
                      <ScorePill score={c.score} />
                      <span className="badge mono">{formatCents(c.mrrCents)}/mois</span>
                      <span
                        className="badge mono"
                        style={{ color: scoreColor(pricePerClip >= 4500 ? 90 : pricePerClip >= 1500 ? 55 : 10) }}
                      >
                        {formatCents(pricePerClip)}/clip
                      </span>
                    </div>
                    <div style={{ fontSize: "0.76rem", color: "var(--text-faint)" }}>
                      {c.email}
                      {c.planName ? ` · ${c.planName}` : ""}
                      {c.handle ? ` · @${c.handle}` : ""}
                      {` · ${c.sourcing === "CLIENT_PROVIDED" ? "fournit ses rushes" : c.sourcing === "SELF_SOURCED" ? "je vais chercher la matière" : "matière mixte"}`}
                    </div>
                    {bd?.summary ? (
                      <p style={{ margin: "0.5rem 0 0", fontSize: "0.83rem", color: "var(--text-muted)" }}>{bd.summary}</p>
                    ) : null}
                  </div>

                  <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "flex-start" }}>
                    {(["prendre", "discuter", "refuser"] as const).map((d) => (
                      <form key={d} action={decideClientAction}>
                        <input type="hidden" name="clientId" value={c.id} />
                        <input type="hidden" name="decision" value={d} />
                        <SubmitButton className={d === "prendre" ? "btn-ok" : d === "refuser" ? "btn-danger" : ""}>
                          {d === "prendre" ? "Prendre" : d === "discuter" ? "À cadrer" : "Refuser"}
                        </SubmitButton>
                      </form>
                    ))}
                  </div>
                </div>

                {/* Production du mois */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.8rem", marginBottom: "1rem" }}>
                  <div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", marginBottom: "0.3rem" }}>
                      Quota du mois · {c.clipsDelivered}/{c.clipsPerMonth}
                    </div>
                    <Meter value={c.clipsDelivered} max={Math.max(1, c.clipsPerMonth)} />
                  </div>
                  <div>
                    <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", marginBottom: "0.3rem" }}>
                      Priorité de production · {prio.priority}
                    </div>
                    <Meter value={prio.priority} />
                    <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", marginTop: "0.25rem" }}>{prio.reason}</div>
                  </div>
                  <div style={{ fontSize: "0.78rem", color: "var(--text-muted)" }}>
                    <div>{c.rushes.length} rush(s) · {c.clips.length} clip(s)</div>
                    <div style={{ color: "var(--text-faint)", fontSize: "0.73rem" }}>{formatCompact(views)} vues cumulées</div>
                    {c.currentPeriodEnd ? (
                      <div style={{ color: "var(--text-faint)", fontSize: "0.73rem" }}>
                        période jusqu'au {new Date(c.currentPeriodEnd).toLocaleDateString("fr-FR")}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "0.4rem", flexWrap: "wrap" }}>
                    <Link href={`/rushes?client=${c.id}`} className="btn">Ses rushes</Link>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "1.4rem" }}>
                  <details>
                    <summary style={{ cursor: "pointer", fontSize: "0.82rem", fontWeight: 600 }}>Détail de la qualification</summary>
                    <div style={{ marginTop: "0.8rem" }}>
                      {bd?.components ? <ScoreBreakdown criteria={bd.components} /> : <p style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>—</p>}
                    </div>
                  </details>

                  <details>
                    <summary style={{ cursor: "pointer", fontSize: "0.82rem", fontWeight: 600 }}>
                      Brief de montage {c.brief ? "" : "— à remplir"}
                    </summary>
                    <form action={updateClientBriefAction} style={{ marginTop: "0.8rem", display: "grid", gap: "0.55rem" }}>
                      <input type="hidden" name="clientId" value={c.id} />
                      <label style={{ fontSize: "0.73rem", color: "var(--text-muted)", display: "grid", gap: "0.25rem" }}>
                        Brief
                        <textarea className="textarea" name="brief" rows={3} defaultValue={c.brief ?? ""} />
                      </label>
                      <label style={{ fontSize: "0.73rem", color: "var(--text-muted)", display: "grid", gap: "0.25rem" }}>
                        Consignes de hook
                        <textarea className="textarea" name="hookGuidelines" rows={2} defaultValue={c.hookGuidelines ?? ""} />
                      </label>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                        <label style={{ fontSize: "0.73rem", color: "var(--text-muted)", display: "grid", gap: "0.25rem" }}>
                          Ton
                          <input className="input" name="brandVoice" defaultValue={c.brandVoice ?? ""} />
                        </label>
                        <label style={{ fontSize: "0.73rem", color: "var(--text-muted)", display: "grid", gap: "0.25rem" }}>
                          À éviter
                          <input className="input" name="avoid" defaultValue={c.avoid ?? ""} />
                        </label>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "0.5rem" }}>
                        <label style={{ fontSize: "0.73rem", color: "var(--text-muted)", display: "grid", gap: "0.25rem" }}>
                          Durée min
                          <input className="input mono" name="minClipSeconds" type="number" min={5} max={180} defaultValue={c.minClipSeconds} />
                        </label>
                        <label style={{ fontSize: "0.73rem", color: "var(--text-muted)", display: "grid", gap: "0.25rem" }}>
                          Durée max
                          <input className="input mono" name="maxClipSeconds" type="number" min={10} max={300} defaultValue={c.maxClipSeconds} />
                        </label>
                        <label style={{ fontSize: "0.73rem", color: "var(--text-muted)", display: "grid", gap: "0.25rem" }}>
                          Clips/rush
                          <input className="input mono" name="clipsPerRush" type="number" min={1} max={20} defaultValue={c.clipsPerRush} />
                        </label>
                        <label style={{ fontSize: "0.73rem", color: "var(--text-muted)", display: "grid", gap: "0.25rem" }}>
                          blogId Metricool
                          <input className="input mono" name="metricoolBlogId" defaultValue={c.metricoolBlogId ?? ""} />
                        </label>
                      </div>
                      <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
                        {NETWORKS.map((n) => (
                          <label key={n} style={{ display: "flex", gap: "0.3rem", alignItems: "center", fontSize: "0.78rem" }}>
                            <input type="checkbox" name="targetNetworks" value={n} defaultChecked={c.targetNetworks.includes(n)} />
                            {n}
                          </label>
                        ))}
                      </div>
                      <div>
                        <SubmitButton pendingLabel="Enregistrement…">Enregistrer le brief</SubmitButton>
                      </div>
                    </form>
                  </details>
                </div>

                <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", marginTop: "0.8rem" }}>
                  Arrivé {relativeTime(c.createdAt)}
                  {c.qualifiedAt ? ` · qualifié ${relativeTime(c.qualifiedAt)}` : ""}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
