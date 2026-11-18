import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty, Stat } from "@/components/ui";
import { formatCents, formatCompact } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const campaigns = await prisma.campaign.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      owner: true,
      _count: { select: { rushes: true, clips: true, assignments: true } },
      clips: { select: { views: true, status: true } },
      payouts: { select: { amountCents: true } },
    },
  });

  return (
    <>
      <PageHeader
        title="Campagnes"
        description="La campagne porte le brief : réseaux visés, format des clips, consignes de hook, rémunération. C'est elle qui paramètre la détection (durée min/max, nombre de clips par rush) et la publication (marque Metricool de destination)."
      />

      {campaigns.length === 0 ? (
        <Empty title="Aucune campagne" />
      ) : (
        <div style={{ display: "grid", gap: "1.2rem" }}>
          {campaigns.map((c) => {
            const views = c.clips.reduce((s, x) => s + x.views, 0);
            const spent = c.payouts.reduce((s, p) => s + p.amountCents, 0);
            const published = c.clips.filter((x) => x.status === "PUBLISHED").length;
            return (
              <article key={c.id} className="card" style={{ padding: "1.3rem 1.4rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", alignItems: "flex-start", marginBottom: "1rem", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.4rem" }}>
                      <h2 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 620 }}>{c.name}</h2>
                      <StatusBadge status={c.status} />
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "var(--text-faint)" }}>
                      {c.owner.name} · {c.targetNetworks.join(", ") || "aucun réseau"} · clips {c.minClipSeconds}–{c.maxClipSeconds} s · {c.clipsPerRush} par rush
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <span className="badge">CPM {formatCents(c.cpmCents)}</span>
                    <span className="badge">fixe {formatCents(c.flatRateCents)}</span>
                    <span className="badge">budget {formatCents(c.budgetCents)}</span>
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "0.8rem", marginBottom: "1rem" }}>
                  <Stat label="Rushes" value={c._count.rushes} />
                  <Stat label="Clips" value={c._count.clips} sub={`${published} publiés`} />
                  <Stat label="Missions" value={c._count.assignments} />
                  <Stat label="Vues" value={formatCompact(views)} accent="#4ade80" />
                  <Stat label="Dépensé" value={formatCents(spent)} sub={`sur ${formatCents(c.budgetCents)}`} />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "1.2rem" }}>
                  <div>
                    <h3 style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", margin: "0 0 0.4rem" }}>Brief</h3>
                    <p style={{ margin: 0, fontSize: "0.83rem", lineHeight: 1.6, color: "var(--text-muted)" }}>{c.brief ?? "—"}</p>
                  </div>
                  <div>
                    <h3 style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", margin: "0 0 0.4rem" }}>Consignes de hook</h3>
                    <p style={{ margin: 0, fontSize: "0.83rem", lineHeight: 1.6, color: "var(--text-muted)" }}>{c.hookGuidelines ?? "—"}</p>
                    <p style={{ margin: "0.6rem 0 0", fontSize: "0.74rem", color: "var(--text-faint)" }}>
                      Ces consignes sont transmises au générateur de hooks lorsqu'un modèle de langage est configuré.
                    </p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
