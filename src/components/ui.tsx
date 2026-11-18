import { cn } from "@/lib/utils";

/** Couleur d'un score : rouge sous 40, ambre sous 70, vert au-dessus. */
export function scoreColor(score: number): string {
  if (score >= 70) return "#22c55e";
  if (score >= 40) return "#f59e0b";
  return "#ef4444";
}

export function Meter({ value, max = 100, className }: { value: number; max?: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={cn("meter", className)} role="meter" aria-valuenow={value} aria-valuemax={max}>
      <span style={{ width: `${pct}%`, background: scoreColor((value / max) * 100) }} />
    </div>
  );
}

export function ScorePill({ score, label }: { score: number; label?: string }) {
  return (
    <span
      className="badge mono"
      style={{ color: scoreColor(score), borderColor: `${scoreColor(score)}44`, background: `${scoreColor(score)}14` }}
    >
      {label ? `${label} ` : ""}
      {score}
      <span style={{ opacity: 0.5 }}>/100</span>
    </span>
  );
}

const STATUS_STYLES: Record<string, { bg: string; fg: string; label?: string }> = {
  // Candidatures
  PENDING: { bg: "#f59e0b18", fg: "#fbbf24", label: "En attente" },
  SHORTLISTED: { bg: "#06b6d418", fg: "#22d3ee", label: "Présélectionné" },
  ACCEPTED: { bg: "#22c55e18", fg: "#4ade80", label: "Accepté" },
  REJECTED: { bg: "#ef444418", fg: "#f87171", label: "Écarté" },
  // Rush
  UPLOADED: { bg: "#64748b18", fg: "#94a3b8", label: "Reçu" },
  TRANSCRIBING: { bg: "#06b6d418", fg: "#22d3ee", label: "Transcription" },
  DETECTING: { bg: "#a855f718", fg: "#c084fc", label: "Détection" },
  READY: { bg: "#22c55e18", fg: "#4ade80", label: "Prêt" },
  FAILED: { bg: "#ef444418", fg: "#f87171", label: "Échec" },
  // Clips
  DRAFT: { bg: "#64748b18", fg: "#94a3b8", label: "Brouillon" },
  RENDERING: { bg: "#06b6d418", fg: "#22d3ee", label: "Rendu…" },
  SUBMITTED: { bg: "#6c5cff18", fg: "#a5b4fc", label: "Soumis" },
  CHANGES_REQUESTED: { bg: "#f59e0b18", fg: "#fbbf24", label: "À corriger" },
  APPROVED: { bg: "#22c55e18", fg: "#4ade80", label: "Validé" },
  SCHEDULED: { bg: "#06b6d418", fg: "#22d3ee", label: "Planifié" },
  PUBLISHED: { bg: "#22c55e18", fg: "#4ade80", label: "Publié" },
  QUEUED: { bg: "#64748b18", fg: "#94a3b8", label: "En file" },
  SCHEDULING: { bg: "#06b6d418", fg: "#22d3ee", label: "Envoi…" },
  CANCELED: { bg: "#64748b18", fg: "#94a3b8", label: "Annulé" },
  // Moments
  CANDIDATE: { bg: "#64748b18", fg: "#94a3b8", label: "Candidat" },
  SELECTED: { bg: "#6c5cff18", fg: "#a5b4fc", label: "Retenu" },
  CLIPPED: { bg: "#22c55e18", fg: "#4ade80", label: "Monté" },
  DISCARDED: { bg: "#ef444418", fg: "#f87171", label: "Écarté" },
  // Missions
  OPEN: { bg: "#6c5cff18", fg: "#a5b4fc", label: "Ouverte" },
  IN_PROGRESS: { bg: "#06b6d418", fg: "#22d3ee", label: "En cours" },
  COMPLETED: { bg: "#22c55e18", fg: "#4ade80", label: "Terminée" },
  EXPIRED: { bg: "#ef444418", fg: "#f87171", label: "Expirée" },
  // Tiers
  ROOKIE: { bg: "#64748b18", fg: "#94a3b8", label: "Rookie" },
  VERIFIED: { bg: "#06b6d418", fg: "#22d3ee", label: "Vérifié" },
  PRO: { bg: "#6c5cff18", fg: "#a5b4fc", label: "Pro" },
  ELITE: { bg: "#f59e0b18", fg: "#fbbf24", label: "Élite" },
  // Campagnes
  ACTIVE: { bg: "#22c55e18", fg: "#4ade80", label: "Active" },
  PAUSED: { bg: "#f59e0b18", fg: "#fbbf24", label: "En pause" },
  ARCHIVED: { bg: "#64748b18", fg: "#94a3b8", label: "Archivée" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? { bg: "#64748b18", fg: "#94a3b8" };
  return (
    <span className="badge" style={{ background: s.bg, color: s.fg, borderColor: `${s.fg}33` }}>
      {s.label ?? status}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="card" style={{ padding: "1rem 1.1rem" }}>
      <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-faint)", fontWeight: 600 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: "1.8rem", fontWeight: 650, marginTop: "0.35rem", color: accent ?? "var(--text)", lineHeight: 1.1 }}>
        {value}
      </div>
      {sub ? <div style={{ fontSize: "0.76rem", color: "var(--text-muted)", marginTop: "0.3rem" }}>{sub}</div> : null}
    </div>
  );
}

export function PageHeader({
  stage,
  title,
  description,
  actions,
}: {
  stage?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1.5rem", marginBottom: "1.6rem", flexWrap: "wrap" }}>
      <div style={{ minWidth: 0 }}>
        {stage ? (
          <div style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--accent)", marginBottom: "0.4rem" }}>
            {stage}
          </div>
        ) : null}
        <h1 style={{ margin: 0, fontSize: "1.6rem", fontWeight: 650, letterSpacing: "-0.02em" }}>{title}</h1>
        {description ? (
          <p style={{ margin: "0.5rem 0 0", color: "var(--text-muted)", fontSize: "0.9rem", maxWidth: "62ch", lineHeight: 1.55 }}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>{actions}</div> : null}
    </header>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card" style={{ padding: "2.5rem 1.5rem", textAlign: "center" }}>
      <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>{title}</div>
      {hint ? <div style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{hint}</div> : null}
    </div>
  );
}

export type Criterion = { key: string; label: string; raw: number | string; points: number; max: number; note?: string };

/** Détail d'un score : chaque critère, ses points, sa valeur brute. */
export function ScoreBreakdown({ criteria, penalties }: { criteria: Criterion[]; penalties?: Criterion[] }) {
  return (
    <div style={{ display: "grid", gap: "0.6rem" }}>
      {criteria.map((c) => (
        <div key={c.key}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "1rem", fontSize: "0.78rem", marginBottom: "0.25rem" }}>
            <span style={{ color: "var(--text-muted)" }}>{c.label}</span>
            <span className="mono" style={{ color: scoreColor((c.points / Math.max(1, c.max)) * 100) }}>
              {c.points}/{c.max}
            </span>
          </div>
          <Meter value={c.points} max={c.max} />
          <div style={{ fontSize: "0.72rem", color: "var(--text-faint)", marginTop: "0.25rem" }}>
            {String(c.raw)}
            {c.note ? ` · ${c.note}` : ""}
          </div>
        </div>
      ))}
      {penalties
        ?.filter((p) => p.points !== 0)
        .map((p) => (
          <div key={p.key} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.78rem", color: "#f87171" }}>
            <span>{p.label}{p.note ? ` — ${p.note}` : ""}</span>
            <span className="mono">{p.points}</span>
          </div>
        ))}
    </div>
  );
}
