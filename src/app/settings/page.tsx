import { prisma } from "@/lib/db";
import { PageHeader, Empty } from "@/components/ui";
import { integrationStatuses, config } from "@/lib/config";
import { SUBSCRIBED_EVENTS } from "@/lib/whop/webhook";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { CopyButton } from "@/components/CopyButton";
import { checkDeliveryTarget } from "@/lib/delivery/drive";
import path from "node:path";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const integrations = integrationStatuses();
  const [webhooks, deliveryTarget, deliveries] = await Promise.all([
    prisma.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 10 }),
    checkDeliveryTarget(),
    prisma.delivery.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { clip: { select: { title: true } }, client: { select: { name: true } } },
    }),
  ]);

  // Le chemin absolu du serveur MCP, pour que la configuration soit
  // copiable telle quelle dans Claude Desktop.
  const serverPath = path.join(process.cwd(), "mcp", "clipflow-server.mjs");
  const desktopConfig = JSON.stringify(
    {
      mcpServers: {
        clipflow: {
          command: "node",
          args: [serverPath],
          env: { CLIPFLOW_URL: config.publicBaseUrl },
        },
      },
    },
    null,
    2,
  );

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

      {/* ── Claude Desktop ───────────────────────────────── */}
      <section className="card" style={{ padding: "1.2rem 1.3rem", marginBottom: "1.4rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", flexWrap: "wrap" }}>
          <div>
            <h2 style={{ margin: "0 0 0.3rem", fontSize: "1rem", fontWeight: 620 }}>Brancher Claude Desktop</h2>
            <p style={{ margin: 0, fontSize: "0.82rem", color: "var(--text-muted)", maxWidth: "72ch", lineHeight: 1.6 }}>
              Claude parle directement à cet atelier : il lit le travail du jour, ouvre les rushes,
              pose ses montages, déclenche les rendus et dépose les clips dans le dossier synchronisé.
              Rien à coller à la main.
            </p>
          </div>
          <CopyButton className="btn-primary" text={desktopConfig} label="Copier la configuration" copiedLabel="Copié" />
        </div>

        <ol style={{ margin: "1rem 0 0", paddingLeft: "1.2rem", fontSize: "0.84rem", lineHeight: 1.8, color: "var(--text-muted)" }}>
          <li>Laisser cet atelier tourner (<code className="mono">npm run dev</code>).</li>
          <li>
            Ouvrir Claude Desktop → <strong>Réglages</strong> → <strong>Développeur</strong> →{" "}
            <strong>Modifier la configuration</strong>, ce qui ouvre <code className="mono">claude_desktop_config.json</code>.
          </li>
          <li>Y coller le bloc ci-dessous, puis redémarrer Claude Desktop.</li>
          <li>
            Dans une conversation, l'outil <code className="mono">clipflow</code> apparaît : demandez
            « qu'est-ce que j'ai à monter aujourd'hui ? », ou lancez la commande <code className="mono">/monter</code>.
          </li>
        </ol>

        <pre
          className="mono"
          style={{
            marginTop: "0.9rem",
            padding: "0.9rem",
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 9,
            fontSize: "0.74rem",
            lineHeight: 1.6,
            overflowX: "auto",
          }}
        >
          {desktopConfig}
        </pre>
        <p style={{ margin: "0.7rem 0 0", fontSize: "0.75rem", color: "var(--text-faint)" }}>
          12 outils exposés : whats_next, get_rush, get_transcript, get_brief, submit_edit_plan,
          render_plan, list_clips, get_clip, review_clip, deliver_clip, delivery_status, schedule_clip.
        </p>
      </section>

      {/* ── Livraison ────────────────────────────────────── */}
      <section className="card" style={{ padding: "1.2rem 1.3rem", marginBottom: "1.4rem" }}>
        <h2 style={{ margin: "0 0 0.3rem", fontSize: "1rem", fontWeight: 620 }}>Dossier de livraison</h2>
        <p style={{ margin: "0 0 0.9rem", fontSize: "0.82rem", color: "var(--text-muted)", maxWidth: "72ch", lineHeight: 1.6 }}>
          Les clips validés sont déposés ici, rangés par client et par date, avec leur vignette et une
          fiche de légende. Si ce dossier est synchronisé par Drive, le fichier part en ligne tout seul.
        </p>
        <div
          style={{
            display: "flex",
            gap: "0.6rem",
            alignItems: "center",
            padding: "0.7rem 0.9rem",
            borderRadius: 9,
            border: `1px solid ${deliveryTarget.ok ? "#22c55e44" : "#f59e0b44"}`,
            background: deliveryTarget.ok ? "#22c55e0d" : "#f59e0b0d",
            fontSize: "0.82rem",
          }}
        >
          <span className="badge" style={deliveryTarget.ok ? { color: "#4ade80", borderColor: "#22c55e44" } : { color: "#fbbf24", borderColor: "#f59e0b44" }}>
            {deliveryTarget.ok ? "prêt" : "à configurer"}
          </span>
          <span className="mono" style={{ color: "var(--text-muted)" }}>{deliveryTarget.message}</span>
        </div>
        <p style={{ margin: "0.7rem 0 0", fontSize: "0.75rem", color: "var(--text-faint)" }}>
          Variable <code className="mono">CLIPFLOW_DELIVERY_DIR</code> ·{" "}
          livraison automatique à la validation : {config.delivery.auto ? "activée" : "désactivée"}
          {config.delivery.publicBase ? ` · base publique : ${config.delivery.publicBase}` : ""}
        </p>

        {deliveries.length ? (
          <table className="data" style={{ marginTop: "1rem" }}>
            <thead><tr><th>Clip</th><th>Client</th><th>Fichier déposé</th><th>Statut</th><th>Quand</th></tr></thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id}>
                  <td>{d.clip.title}</td>
                  <td style={{ color: "var(--text-muted)", fontSize: "0.8rem" }}>{d.client?.name ?? "—"}</td>
                  <td className="mono" style={{ fontSize: "0.73rem" }}>{d.filePath}</td>
                  <td style={{ fontSize: "0.78rem", color: d.status === "DELIVERED" ? "#4ade80" : "#f87171" }}>
                    {d.status === "DELIVERED" ? "déposé" : (d.error ?? d.status)}
                  </td>
                  <td style={{ fontSize: "0.74rem", color: "var(--text-faint)" }}>
                    {relativeTime(d.deliveredAt ?? d.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
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
