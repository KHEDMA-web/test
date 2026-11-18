import { prisma } from "@/lib/db";
import { PageHeader, Empty } from "@/components/ui";
import { integrationStatuses, config } from "@/lib/config";
import { SUBSCRIBED_EVENTS } from "@/lib/whop/webhook";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const integrations = integrationStatuses();
  const webhooks = await prisma.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 10 });

  return (
    <>
      <PageHeader
        title="Réglages et intégrations"
        description="Chaque étage bascule du mock au réel dès que ses clés sont renseignées dans l'environnement. Aucune autre modification n'est nécessaire : le code appelant est identique dans les deux modes."
      />

      <section className="card" style={{ overflow: "hidden", marginBottom: "1.4rem" }}>
        <table className="data">
          <thead>
            <tr><th>Étage</th><th>Intégration</th><th>Mode</th><th>Variables manquantes</th><th>Documentation</th></tr>
          </thead>
          <tbody>
            {integrations.map((i) => (
              <tr key={i.key}>
                <td style={{ fontSize: "0.78rem", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{i.stage}</td>
                <td style={{ fontWeight: 500 }}>{i.label}</td>
                <td>
                  <span
                    className="badge"
                    style={
                      i.mode === "live"
                        ? { color: "#4ade80", borderColor: "#22c55e44", background: "#22c55e14" }
                        : { color: "#fbbf24", borderColor: "#f59e0b44", background: "#f59e0b14" }
                    }
                  >
                    {i.mode === "live" ? "réel" : "mock"}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: "0.74rem", color: i.missing.length ? "#fbbf24" : "var(--text-faint)" }}>
                  {i.missing.length ? i.missing.join(", ") : "aucune"}
                </td>
                <td style={{ fontSize: "0.74rem" }}>
                  <a href={i.docs} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                    {new URL(i.docs).hostname}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: "1.2rem", marginBottom: "1.4rem" }}>
        <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
          <h2 style={{ margin: "0 0 0.7rem", fontSize: "0.9rem", fontWeight: 600 }}>Webhook Whop</h2>
          <p style={{ margin: "0 0 0.7rem", fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
            Dans le dashboard Whop : <strong>Developer → Webhooks → Create webhook</strong>, version d'API <strong>v1</strong>,
            URL ci-dessous. La signature suit la spécification Standard Webhooks : en-têtes <code className="mono">webhook-id</code>,{" "}
            <code className="mono">webhook-timestamp</code>, <code className="mono">webhook-signature</code>, HMAC-SHA256 sur le corps brut.
          </p>
          <code
            className="mono"
            style={{ display: "block", padding: "0.6rem 0.7rem", background: "var(--bg)", border: "1px solid var(--border-strong)", borderRadius: 8, fontSize: "0.78rem", wordBreak: "break-all" }}
          >
            {config.publicBaseUrl}/api/whop/webhook
          </code>
          <div style={{ marginTop: "0.8rem", display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
            {SUBSCRIBED_EVENTS.map((e) => <span key={e} className="badge mono" style={{ fontSize: "0.66rem" }}>{e}</span>)}
          </div>
        </section>

        <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
          <h2 style={{ margin: "0 0 0.7rem", fontSize: "0.9rem", fontWeight: 600 }}>Metricool</h2>
          <p style={{ margin: "0 0 0.7rem", fontSize: "0.8rem", color: "var(--text-muted)", lineHeight: 1.6 }}>
            Le jeton se trouve dans <strong>Account Settings → API</strong> (offres Advanced et Custom uniquement).
            <code className="mono"> userId</code> et <code className="mono">blogId</code> se lisent dans l'URL de l'application.
            Les appels doivent partir du serveur : un appel direct depuis le navigateur est refusé en préflight CORS.
          </p>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.3rem 0.8rem", fontSize: "0.78rem" }}>
            <dt style={{ color: "var(--text-faint)" }}>userId</dt>
            <dd className="mono" style={{ margin: 0 }}>{config.metricool.userId || "non configuré"}</dd>
            <dt style={{ color: "var(--text-faint)" }}>blogId</dt>
            <dd className="mono" style={{ margin: 0 }}>{config.metricool.blogId || "non configuré"}</dd>
            <dt style={{ color: "var(--text-faint)" }}>fuseau</dt>
            <dd className="mono" style={{ margin: 0 }}>{config.metricool.timezone}</dd>
            <dt style={{ color: "var(--text-faint)" }}>média</dt>
            <dd style={{ margin: 0 }}>URL publique non expirante requise</dd>
          </dl>
        </section>
      </div>

      <section className="card" style={{ padding: "1.1rem 1.2rem" }}>
        <h2 style={{ margin: "0 0 0.7rem", fontSize: "0.9rem", fontWeight: 600 }}>Derniers webhooks reçus</h2>
        {webhooks.length === 0 ? (
          <Empty title="Aucun webhook reçu" hint="Les livraisons Whop apparaissent ici, dédupliquées sur l'en-tête webhook-id." />
        ) : (
          <table className="data">
            <thead><tr><th>Source</th><th>Événement</th><th>webhook-id</th><th>Traité</th><th>Reçu</th></tr></thead>
            <tbody>
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <td>{w.source}</td>
                  <td className="mono" style={{ fontSize: "0.76rem" }}>{w.eventType}</td>
                  <td className="mono" style={{ fontSize: "0.72rem", color: "var(--text-faint)" }}>{w.externalId}</td>
                  <td style={{ color: w.error ? "#f87171" : "#4ade80", fontSize: "0.78rem" }}>{w.error ?? "oui"}</td>
                  <td style={{ fontSize: "0.74rem", color: "var(--text-faint)" }}>{formatDateTime(w.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
