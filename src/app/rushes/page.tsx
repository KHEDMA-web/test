import Link from "next/link";
import { prisma } from "@/lib/db";
import { PageHeader, StatusBadge, Empty, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { demoRushAction, ingestLinkAction, uploadRushAction } from "@/app/actions";
import { formatDuration, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RushesPage({
  searchParams,
}: {
  searchParams: Promise<{ client?: string }>;
}) {
  const { client: clientFilter } = await searchParams;

  const [rushes, clients] = await Promise.all([
    prisma.rush.findMany({
      where: clientFilter ? { clientId: clientFilter } : undefined,
      orderBy: { createdAt: "desc" },
      include: {
        client: true,
        _count: { select: { moments: true, clips: true, segments: true, editPlans: true } },
      },
    }),
    prisma.client.findMany({
      where: { status: { in: ["ACTIVE", "TRIAL"] } },
      orderBy: { name: "asc" },
    }),
  ]);

  const ready = rushes.filter((r) => r.status === "READY").length;
  const filtered = clients.find((c) => c.id === clientFilter);

  return (
    <>
      <PageHeader
        stage="Étage 2 · Rush"
        title={filtered ? `Rushes — ${filtered.name}` : "Rushes"}
        description="La matière première : ce que le client dépose, ou ce que je vais chercher chez lui. Chaque rush est sondé, transcrit au mot, puis découpé en moments candidats qui alimenteront le brief de montage."
        actions={
          <>
            {filtered ? <Link href="/rushes" className="btn">Tous les clients</Link> : null}
            <form action={demoRushAction}>
              <input type="hidden" name="clientId" value={clientFilter ?? clients[0]?.id ?? ""} />
              <SubmitButton pendingLabel="Génération + analyse…">Rush de test</SubmitButton>
            </form>
          </>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.9rem", marginBottom: "1.4rem" }}>
        <Stat label="Rushes" value={rushes.length} sub={`${ready} analysés`} />
        <Stat label="Durée ingérée" value={formatDuration(rushes.reduce((s, r) => s + (r.durationSec ?? 0), 0))} />
        <Stat label="Montages" value={rushes.reduce((s, r) => s + r._count.editPlans, 0)} sub="plans enregistrés" />
        <Stat label="Clips" value={rushes.reduce((s, r) => s + r._count.clips, 0)} />
      </div>

      <section className="card" style={{ padding: "1.1rem 1.2rem", marginBottom: "1.4rem" }}>
        <h2 style={{ margin: "0 0 0.9rem", fontSize: "0.9rem", fontWeight: 600 }}>Ajouter de la matière</h2>

        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "1.4rem" }}>
          <form action={uploadRushAction} style={{ display: "grid", gap: "0.55rem" }}>
            <div style={{ fontSize: "0.76rem", color: "var(--text-muted)", fontWeight: 600 }}>Déposer un fichier</div>
            <input className="input" type="file" name="file" accept="video/*,audio/*" required />
            <input className="input" name="title" placeholder="Titre du rush" />
            <select className="select" name="clientId" defaultValue={clientFilter ?? clients[0]?.id ?? ""}>
              <option value="">Aucun client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div><SubmitButton pendingLabel="Analyse…">Importer le fichier</SubmitButton></div>
          </form>

          <form action={ingestLinkAction} style={{ display: "grid", gap: "0.55rem" }}>
            <div style={{ fontSize: "0.76rem", color: "var(--text-muted)", fontWeight: 600 }}>
              Depuis un lien
            </div>
            <input
              className="input"
              name="url"
              type="url"
              placeholder="YouTube, Twitch (rediffusion ou direct), Vimeo, ou un .mp4 direct"
              required
            />
            <input className="input" name="title" placeholder="Titre (sinon celui de la source)" />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
              <select className="select" name="clientId" defaultValue={clientFilter ?? clients[0]?.id ?? ""}>
                <option value="">Aucun client</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select className="select" name="maxHeight" defaultValue="1080">
                <option value="720">720p — rapide</option>
                <option value="1080">1080p — recommandé</option>
                <option value="1440">1440p — si la source le permet</option>
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "0.5rem" }}>
              <label style={{ fontSize: "0.72rem", color: "var(--text-faint)", display: "grid", gap: "0.2rem" }}>
                Début (s)
                <input className="input mono" name="startSec" type="number" min={0} placeholder="tout" />
              </label>
              <label style={{ fontSize: "0.72rem", color: "var(--text-faint)", display: "grid", gap: "0.2rem" }}>
                Fin (s)
                <input className="input mono" name="endSec" type="number" min={0} placeholder="tout" />
              </label>
              <label style={{ fontSize: "0.72rem", color: "var(--text-faint)", display: "grid", gap: "0.2rem" }}>
                Direct : minutes
                <input className="input mono" name="recordMinutes" type="number" min={1} max={240} placeholder="10" />
              </label>
            </div>
            <p style={{ margin: 0, fontSize: "0.72rem", color: "var(--text-faint)", lineHeight: 1.5 }}>
              Sur une vidéo publiée, début et fin évitent de rapatrier six heures de direct pour en garder
              dix minutes. Sur un <strong>direct en cours</strong>, son passé n'est pas récupérable : la
              capture démarre à l'instant où vous validez, pour la durée indiquée.
            </p>
            <div><SubmitButton pendingLabel="Récupération…">Importer le lien</SubmitButton></div>
          </form>
        </div>
      </section>

      {rushes.length === 0 ? (
        <Empty title="Aucun rush" hint="Déposez un fichier, importez une URL, ou générez un rush de test." />
      ) : (
        <section className="card" style={{ overflow: "hidden" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Rush</th>
                <th>Client</th>
                <th>Provenance</th>
                <th>Durée</th>
                <th>Segments</th>
                <th>Moments</th>
                <th>Montages</th>
                <th>État</th>
                <th>Reçu</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rushes.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/rushes/${r.id}`} style={{ fontWeight: 550 }}>{r.title}</Link>
                    <div style={{ fontSize: "0.71rem", color: "var(--text-faint)" }}>
                      {r.transcriptProvider ? `transcrit via ${r.transcriptProvider}` : "non transcrit"}
                    </div>
                  </td>
                  <td style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{r.client?.name ?? "—"}</td>
                  <td style={{ fontSize: "0.75rem", color: "var(--text-faint)" }}>
                    {r.origin === "CLIENT_UPLOAD" ? "client" : "sourcé"}
                  </td>
                  <td className="mono">{formatDuration(r.durationSec)}</td>
                  <td className="mono">{r._count.segments}</td>
                  <td className="mono">{r._count.moments}</td>
                  <td className="mono">{r._count.editPlans}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td style={{ fontSize: "0.73rem", color: "var(--text-faint)" }}>{relativeTime(r.createdAt)}</td>
                  <td>
                    {r.transcriptStatus === "DONE" ? (
                      <Link href={`/rushes/${r.id}/montage`} className="btn btn-primary">Monter</Link>
                    ) : null}
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
