/**
 * Étage 1 — « chercher les meilleures personnes qui veulent du clipping ».
 *
 * Trois scores distincts, tous explicables (chaque composante est renvoyée
 * avec sa valeur brute, son poids et les points obtenus) :
 *
 *   1. scoreApplication  — trier les candidatures arrivées par Whop
 *   2. scoreClipper      — classer les clippers sur leurs résultats réels
 *   3. matchClipperToRush— attribuer le bon rush au bon clipper
 *
 * Aucune composante n'est une boîte noire : l'UI affiche le détail pour que
 * la décision humaine reste possible.
 */
import { clamp } from "../utils";

export type ScoreComponent = {
  key: string;
  label: string;
  /** Valeur brute observée (nombre de liens, vues, taux...). */
  raw: number | string;
  /** Points obtenus sur ce critère. */
  points: number;
  /** Points maximum du critère. */
  max: number;
  note?: string;
};

export type ScoreResult = {
  score: number;
  components: ScoreComponent[];
  decision: "accept" | "shortlist" | "reject";
  summary: string;
};

/** Échelle logarithmique : 0 → 0 point, `ceiling` → `max` points. */
function logScale(value: number, ceiling: number, max: number): number {
  if (value <= 0) return 0;
  const ratio = Math.log10(1 + value) / Math.log10(1 + ceiling);
  return clamp(Math.round(ratio * max), 0, max);
}

const PRO_TOOLS = ["premiere pro", "after effects", "davinci resolve", "final cut pro"];

export type ApplicationInput = {
  portfolioUrls?: string[];
  followerCount?: number | null;
  pastClipViews?: number | null;
  editingTools?: string[];
  niches?: string[];
  languages?: string[];
  membershipStatus?: string | null;
  membershipValid?: boolean;
  /** Niches recherchées par les campagnes actives. */
  demandNiches?: string[];
};

/**
 * Score de candidature sur 100.
 * Barème : preuves de travail 25 · traction passée 25 · niche demandée 15 ·
 * audience 15 · outils 10 · accès Whop valide 10.
 */
export function scoreApplication(input: ApplicationInput): ScoreResult {
  const portfolio = input.portfolioUrls?.length ?? 0;
  const views = input.pastClipViews ?? 0;
  const followers = input.followerCount ?? 0;
  const tools = (input.editingTools ?? []).map((t) => t.toLowerCase());
  const niches = (input.niches ?? []).map((n) => n.toLowerCase());
  const demand = (input.demandNiches ?? []).map((n) => n.toLowerCase());

  const proTools = tools.filter((t) => PRO_TOOLS.some((p) => t.includes(p))).length;
  const nicheHits = demand.length ? niches.filter((n) => demand.includes(n)).length : 0;

  const components: ScoreComponent[] = [
    {
      key: "portfolio",
      label: "Preuves de travail",
      raw: portfolio,
      points: clamp(portfolio * 7, 0, 25),
      max: 25,
      note: portfolio === 0 ? "Aucun clip montré" : `${portfolio} clip(s) en référence`,
    },
    {
      key: "traction",
      label: "Vues cumulées sur ses clips",
      raw: views,
      points: logScale(views, 5_000_000, 25),
      max: 25,
      note: views === 0 ? "Pas d'historique" : undefined,
    },
    {
      key: "niche",
      label: "Niche demandée par les campagnes",
      raw: nicheHits ? niches.filter((n) => demand.includes(n)).join(", ") : "aucune",
      points: demand.length === 0 ? 8 : clamp(nicheHits * 8, 0, 15),
      max: 15,
      note: demand.length === 0 ? "Aucune campagne active : score neutre" : undefined,
    },
    {
      key: "audience",
      label: "Audience propre",
      raw: followers,
      points: logScale(followers, 100_000, 15),
      max: 15,
    },
    {
      key: "tools",
      label: "Outils de montage",
      raw: tools.join(", ") || "non renseigné",
      points: clamp(proTools * 5 + (tools.length ? 3 : 0), 0, 10),
      max: 10,
    },
    {
      key: "access",
      label: "Accès Whop",
      raw: input.membershipStatus ?? "inconnu",
      points: input.membershipValid ? 10 : input.membershipStatus === "past_due" ? 3 : 0,
      max: 10,
      note: input.membershipValid ? undefined : "Membership non valide : accès à confirmer",
    },
  ];

  const score = clamp(
    components.reduce((sum, c) => sum + c.points, 0),
    0,
    100,
  );

  const decision: ScoreResult["decision"] = score >= 70 ? "accept" : score >= 45 ? "shortlist" : "reject";

  const top = [...components].sort((a, b) => b.points / b.max - a.points / a.max)[0];
  const weak = [...components].sort((a, b) => a.points / a.max - b.points / b.max)[0];
  const summary =
    decision === "accept"
      ? `Accès accordé automatiquement — point fort : ${top.label.toLowerCase()}.`
      : decision === "shortlist"
        ? `À revoir à la main — ${weak.label.toLowerCase()} insuffisant.`
        : `Écarté — ${weak.label.toLowerCase()} trop faible pour le niveau demandé.`;

  return { score, components, decision, summary };
}

export type ClipperStats = {
  clipsSubmitted: number;
  clipsApproved: number;
  clipsPublished: number;
  totalViews: number;
  onTimeRate: number;
  medianTurnaroundH: number;
  lastClipAt?: Date | null;
};

export type ClipperScore = {
  score: number;
  components: ScoreComponent[];
  tier: "ROOKIE" | "VERIFIED" | "PRO" | "ELITE";
};

/**
 * Score de clipper sur 100, basé uniquement sur des résultats observés.
 * Barème : taux de validation 30 · vues moyennes 30 · ponctualité 20 ·
 * volume 10 · activité récente 10.
 */
export function scoreClipper(stats: ClipperStats): ClipperScore {
  const approvalRate = stats.clipsSubmitted > 0 ? stats.clipsApproved / stats.clipsSubmitted : 0;
  const avgViews = stats.clipsPublished > 0 ? Math.round(stats.totalViews / stats.clipsPublished) : 0;
  const daysSinceLast = stats.lastClipAt
    ? (Date.now() - new Date(stats.lastClipAt).getTime()) / 864e5
    : Infinity;

  const components: ScoreComponent[] = [
    {
      key: "approval",
      label: "Taux de validation",
      raw: `${Math.round(approvalRate * 100)} %`,
      // Sous 5 clips soumis, le taux n'est pas fiable : on plafonne à 60 % des points.
      points:
        stats.clipsSubmitted < 5
          ? clamp(Math.round(approvalRate * 30 * 0.6), 0, 18)
          : clamp(Math.round(approvalRate * 30), 0, 30),
      max: 30,
      note: stats.clipsSubmitted < 5 ? "Échantillon trop petit, score bridé" : undefined,
    },
    {
      key: "views",
      label: "Vues moyennes par clip",
      raw: avgViews,
      points: logScale(avgViews, 500_000, 30),
      max: 30,
    },
    {
      key: "ontime",
      label: "Respect des délais",
      raw: `${Math.round(stats.onTimeRate)} %`,
      points: clamp(Math.round((stats.onTimeRate / 100) * 20), 0, 20),
      max: 20,
    },
    {
      key: "volume",
      label: "Volume livré",
      raw: stats.clipsPublished,
      points: logScale(stats.clipsPublished, 200, 10),
      max: 10,
    },
    {
      key: "recency",
      label: "Activité récente",
      raw: Number.isFinite(daysSinceLast) ? `${Math.round(daysSinceLast)} j` : "jamais",
      points: !Number.isFinite(daysSinceLast)
        ? 0
        : daysSinceLast <= 7
          ? 10
          : daysSinceLast <= 21
            ? 6
            : daysSinceLast <= 45
              ? 3
              : 0,
      max: 10,
    },
  ];

  const score = clamp(
    components.reduce((s, c) => s + c.points, 0),
    0,
    100,
  );
  const tier = score >= 80 ? "ELITE" : score >= 60 ? "PRO" : score >= 35 ? "VERIFIED" : "ROOKIE";
  return { score, components, tier };
}

export type MatchInput = {
  clipper: {
    id: string;
    name: string;
    score: number;
    tier: string;
    niches: string[];
    languages: string[];
    openAssignments: number;
    medianTurnaroundH: number;
  };
  campaign: { targetNiches: string[]; language?: string | null };
  /** Nombre de missions simultanées tolérées. */
  capacity?: number;
};

export type MatchResult = { score: number; reason: string; components: ScoreComponent[] };

/** Adéquation clipper ↔ rush/campagne, pour l'attribution. */
export function matchClipperToRush(input: MatchInput): MatchResult {
  const capacity = input.capacity ?? 3;
  const niches = input.clipper.niches.map((n) => n.toLowerCase());
  const target = input.campaign.targetNiches.map((n) => n.toLowerCase());
  const overlap = target.filter((n) => niches.includes(n));
  const langOk =
    !input.campaign.language ||
    input.clipper.languages.map((l) => l.toLowerCase()).includes(input.campaign.language.toLowerCase());
  const load = input.clipper.openAssignments;

  const components: ScoreComponent[] = [
    {
      key: "track-record",
      label: "Score de clipper",
      raw: input.clipper.score,
      points: Math.round((input.clipper.score / 100) * 40),
      max: 40,
    },
    {
      key: "niche",
      label: "Recouvrement de niche",
      raw: overlap.join(", ") || "aucun",
      points: target.length === 0 ? 15 : clamp(Math.round((overlap.length / target.length) * 25), 0, 25),
      max: 25,
    },
    {
      key: "capacity",
      label: "Charge actuelle",
      raw: `${load} mission(s) ouverte(s)`,
      points: load >= capacity ? 0 : clamp(Math.round(((capacity - load) / capacity) * 20), 0, 20),
      max: 20,
      note: load >= capacity ? "Saturé : ne pas attribuer" : undefined,
    },
    {
      key: "speed",
      label: "Délai médian de livraison",
      raw: `${input.clipper.medianTurnaroundH.toFixed(1)} h`,
      points:
        input.clipper.medianTurnaroundH <= 0
          ? 5
          : input.clipper.medianTurnaroundH <= 12
            ? 10
            : input.clipper.medianTurnaroundH <= 24
              ? 7
              : input.clipper.medianTurnaroundH <= 48
                ? 4
                : 1,
      max: 10,
    },
    {
      key: "language",
      label: "Langue",
      raw: langOk ? "compatible" : "non couverte",
      points: langOk ? 5 : 0,
      max: 5,
    },
  ];

  const score = clamp(
    components.reduce((s, c) => s + c.points, 0),
    0,
    100,
  );
  const reason =
    load >= capacity
      ? `${input.clipper.name} est saturé (${load} missions en cours).`
      : overlap.length
        ? `${input.clipper.name} — ${input.clipper.tier}, niche ${overlap.join("/")}, livre en ~${Math.round(input.clipper.medianTurnaroundH)} h.`
        : `${input.clipper.name} — ${input.clipper.tier}, pas de recouvrement de niche mais bon historique.`;

  return { score, reason, components };
}
