import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { runDemoPipelineAction, ingestUrlAction } from "@/app/actions";
import { formatDuration, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RushesPage() {
  const [rushes, campaigns, totalMoments] = await Promise.all([
    prisma.rush.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        campaign: true,
        _count: { select: { moments: true, clips: true, segments: true } },
      },
    }),
    prisma.campaign.findMany({ where: { status: "ACTIVE" } }),
    prisma.moment.count(),
  ]);

  const ready = rushes.filter((r) => r.status === "READY").length;

  return (
    <>
      <PageHeader
        stage="Étage 2 · Rush"
        title="Rushes"
        description="Le rush brut entre ici. Il est sondé (durée, format, piste audio), transcrit avec des horodatages au mot, puis découpé en moments candidats. La transcription et la détection sont relançables indépendamment."
        actions={
          <form action={runDemoPipelineAction}>
            <input type="hidden" name="campaignId" value={campaigns[0]?.id ?? ""} />
            <SubmitButton className="btn-primary" pendingLabel="Génération + pipeline…">
              Rush de test
            </SubmitButton>
          </form>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="Rushes" value={rushes.length} sub={`${ready} prêts à monter`} />
        <Stat label="Moments détectés" value={totalMoments} sub="toutes sources confondues" />
        <Stat
          label="Durée ingérée"
          value={formatDuration(rushes.reduce((s, r) => s + (r.durationSec ?? 0), 0))}
          sub="de rush analysé"
        />
      </div>

      <section className="card" style={{ padding: "1.1rem 1.2rem", marginBottom: "1.4rem" }}>
        <h2 style={{ margin: "0 0 0.8rem", fontSize: "0.88rem", fontWeight: 600 }}>Importer depuis une URL</h2>
        <form action={ingestUrlAction} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.6fr) 12rem auto", gap: "0.6rem", alignItems: "end" }}>
          <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
            Titre
            <input className="input" name="title" placeholder="Épisode 13" required />
          </label>
          <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
            URL du fichier (accessible publiquement)
            <input className="input" name="sourceUrl" type="url" placeholder="https://cdn.exemple.com/episode-13.mp4" required />
          </label>
          <label style={{ display: "grid", gap: "0.3rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
            Campagne
            <select className="select" name="campaignId" defaultValue={campaigns[0]?.id ?? ""}>
              <option value="">Aucune</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <SubmitButton pendingLabel="Analyse…">Importer</SubmitButton>
        </form>
      </section>

      {rushes.length === 0 ? (
        <Empty title="Aucun rush" hint="Importez une URL ou générez un rush de test." />
      ) : (
        <section className="card" style={{ overflow: "hidden" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Rush</th>
                <th>Campagne</th>
                <th>Durée</th>
                <th>Format</th>
                <th>Segments</th>
                <th>Moments</th>
                <th>Clips</th>
                <th>État</th>
                <th>Reçu</th>
              </tr>
            </thead>
            <tbody>
              {rushes.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/rushes/${r.id}`} style={{ fontWeight: 550, color: "var(--text)" }}>
                      {r.title}
                    </Link>
                    <div style={{ fontSize: "0.72rem", color: "var(--text-faint)" }}>
                      {r.transcriptProvider ? `transcrit via ${r.transcriptProvider}` : "non transcrit"}
                    </div>
                  </td>
                  <td style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{r.campaign?.name ?? "—"}</td>
                  <td className="mono">{formatDuration(r.durationSec)}</td>
                  <td className="mono" style={{ fontSize: "0.76rem" }}>
                    {r.width && r.height ? `${r.width}×${r.height}` : "—"}
                  </td>
                  <td className="mono">{r._count.segments}</td>
                  <td className="mono">{r._count.moments}</td>
                  <td className="mono">{r._count.clips}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td style={{ fontSize: "0.74rem", color: "var(--text-faint)" }}>{relativeTime(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
