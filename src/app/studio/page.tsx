import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, ScorePill, Empty, Stat } from "@/components/ui";
import { formatDuration, relativeTime, formatCompact } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function StudioPage() {
  const clips = await prisma.clip.findMany({
    orderBy: { createdAt: "desc" },
    include: { rush: true, moment: true, hook: true, clipper: true, campaign: true },
  });

  const auto = clips.filter((c) => c.origin === "AUTO").length;
  const byClipper = clips.filter((c) => c.origin === "CLIPPER").length;

  return (
    <>
      <PageHeader
        stage="Étage 4 · Montage"
        title="Studio"
        description="Montage hybride : la plateforme rend un brouillon automatique en 9:16 (recadrage, sous-titres incrustés, hook en overlay, son normalisé à -14 LUFS), et le clipper peut déposer sa propre version, qui crée une nouvelle révision sans écraser le brouillon."
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="Clips" value={clips.length} sub={`${auto} auto · ${byClipper} versions clipper`} />
        <Stat label="À valider" value={clips.filter((c) => c.status === "SUBMITTED").length} sub="déposés par les clippers" accent="#fbbf24" />
        <Stat label="Validés" value={clips.filter((c) => ["APPROVED", "SCHEDULED", "PUBLISHED"].includes(c.status)).length} accent="#4ade80" />
        <Stat label="Vues" value={formatCompact(clips.reduce((s, c) => s + c.views, 0))} sub="cumulées" />
      </div>

      {clips.length === 0 ? (
        <Empty title="Aucun clip" hint="Depuis un rush, lancez « Monter en 9:16 » sur un moment." />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: "1rem" }}>
          {clips.map((c) => (
            <Link key={c.id} href={`/studio/${c.id}`} className="card" style={{ overflow: "hidden", display: "block" }}>
              <div style={{ position: "relative", aspectRatio: "9 / 16", background: "#000", display: "grid", placeItems: "center" }}>
                {c.previewPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/media/clips/${c.id}.jpg`}
                    alt=""
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                ) : (
                  <span style={{ color: "var(--text-faint)", fontSize: "0.8rem" }}>pas d'aperçu</span>
                )}
                <div style={{ position: "absolute", top: 8, left: 8, display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                  <StatusBadge status={c.status} />
                  <span className="badge" style={{ background: "#000a" }}>{c.origin === "AUTO" ? "auto" : `v${c.version} clipper`}</span>
                </div>
                <div style={{ position: "absolute", bottom: 8, right: 8 }} className="badge mono">
                  {formatDuration(c.durationSec)}
                </div>
              </div>
              <div style={{ padding: "0.8rem 0.9rem" }}>
                <div style={{ fontSize: "0.85rem", fontWeight: 550, lineHeight: 1.35, marginBottom: "0.35rem" }}>{c.title}</div>
                <div style={{ fontSize: "0.72rem", color: "var(--text-faint)", marginBottom: "0.5rem" }}>
                  {c.rush.title} · {c.clipper?.name ?? "non attribué"} · {relativeTime(c.createdAt)}
                </div>
                <div style={{ display: "flex", gap: "0.35rem", alignItems: "center", flexWrap: "wrap" }}>
                  {c.qaScore !== null ? <ScorePill score={c.qaScore} label="QA" /> : null}
                  {c.views > 0 ? <span className="badge">{formatCompact(c.views)} vues</span> : null}
                </div>
                {c.qaIssues.length ? (
                  <div style={{ fontSize: "0.7rem", color: "#fbbf24", marginTop: "0.45rem" }}>{c.qaIssues[0]}</div>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
