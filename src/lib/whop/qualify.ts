/**
 * Étage 1 — qualifier les clients qui arrivent par Whop.
 *
 * La question n'est pas « ce clippeur est-il bon ? » mais « ce client
 * vaut-il mon temps ? ». Un abonnement généreux sur un compte sans matière
 * ne vaut rien ; une grosse demande de volume à bas prix est un piège.
 *
 * Chaque critère renvoie sa valeur brute, ses points et son maximum :
 * la note est discutable, donc affichée en détail.
 */
import { clamp } from "../utils";

export type ScoreComponent = {
  key: string;
  label: string;
  raw: number | string;
  points: number;
  max: number;
  note?: string;
};

export type QualificationResult = {
  score: number;
  components: ScoreComponent[];
  decision: "prendre" | "discuter" | "refuser";
  summary: string;
  /** Prix effectif par clip, en centimes. Le chiffre qui tranche. */
  pricePerClipCents: number;
};

function logScale(value: number, ceiling: number, max: number): number {
  if (value <= 0) return 0;
  const ratio = Math.log10(1 + value) / Math.log10(1 + ceiling);
  return clamp(Math.round(ratio * max), 0, max);
}

export type ClientInput = {
  mrrCents: number;
  clipsPerMonth: number;
  /** Heures de matière déjà disponibles (chaîne, podcast, archives). */
  backCatalogHours?: number | null;
  sourcing?: "CLIENT_PROVIDED" | "SELF_SOURCED" | "MIXED";
  audienceSize?: number | null;
  pastClipViews?: number | null;
  brief?: string | null;
  hookGuidelines?: string | null;
  niches?: string[];
  targetNetworks?: string[];
  membershipStatus?: string | null;
  membershipValid?: boolean;
  /** Mes niches de prédilection, pour pondérer l'adéquation. */
  myNiches?: string[];
};

/** Seuil en dessous duquel un clip n'est pas rentable à produire. */
export const MIN_VIABLE_PRICE_PER_CLIP_CENTS = 1500;

export function qualifyClient(input: ClientInput): QualificationResult {
  const clips = Math.max(1, input.clipsPerMonth);
  const pricePerClipCents = Math.round(input.mrrCents / clips);
  const catalog = input.backCatalogHours ?? 0;
  const sourcing = input.sourcing ?? "CLIENT_PROVIDED";
  const niches = (input.niches ?? []).map((n) => n.toLowerCase());
  const mine = (input.myNiches ?? []).map((n) => n.toLowerCase());
  const nicheHits = mine.length ? niches.filter((n) => mine.includes(n)) : [];

  // Clarté du brief : chaque élément renseigné, c'est un aller-retour en moins.
  const briefBits = [
    (input.brief ?? "").length > 40,
    (input.hookGuidelines ?? "").length > 20,
    niches.length > 0,
    (input.targetNetworks ?? []).length > 0,
  ].filter(Boolean).length;

  const components: ScoreComponent[] = [
    {
      key: "revenue",
      label: "Valeur de l'abonnement",
      raw: `${(input.mrrCents / 100).toFixed(0)} € / mois`,
      points: logScale(input.mrrCents, 200_000, 25),
      max: 25,
    },
    {
      key: "material",
      label: "Matière disponible",
      raw:
        sourcing === "CLIENT_PROVIDED"
          ? `${catalog} h, fournies par le client`
          : sourcing === "SELF_SOURCED"
            ? `${catalog} h, à aller chercher`
            : `${catalog} h, mixte`,
      // Le client qui dépose ses rushes m'épargne le sourcing.
      points: clamp(
        logScale(catalog, 200, 14) + (sourcing === "CLIENT_PROVIDED" ? 6 : sourcing === "MIXED" ? 4 : 2),
        0,
        20,
      ),
      max: 20,
      note: catalog === 0 ? "Aucune matière annoncée : à vérifier avant de s'engager" : undefined,
    },
    {
      key: "price-per-clip",
      label: "Prix par clip",
      raw: `${(pricePerClipCents / 100).toFixed(2)} € pour ${clips} clips/mois`,
      // En dessous du seuil de viabilité, le volume demandé devient une charge.
      points:
        pricePerClipCents >= MIN_VIABLE_PRICE_PER_CLIP_CENTS * 3
          ? 15
          : pricePerClipCents >= MIN_VIABLE_PRICE_PER_CLIP_CENTS * 1.5
            ? 11
            : pricePerClipCents >= MIN_VIABLE_PRICE_PER_CLIP_CENTS
              ? 7
              : 0,
      max: 15,
      note:
        pricePerClipCents < MIN_VIABLE_PRICE_PER_CLIP_CENTS
          ? `Sous le seuil de viabilité (${MIN_VIABLE_PRICE_PER_CLIP_CENTS / 100} €/clip)`
          : undefined,
    },
    {
      key: "reach",
      label: "Potentiel de diffusion",
      raw: `${input.audienceSize ?? 0} abonnés · ${input.pastClipViews ?? 0} vues passées`,
      points: clamp(
        logScale(input.audienceSize ?? 0, 500_000, 8) + logScale(input.pastClipViews ?? 0, 5_000_000, 7),
        0,
        15,
      ),
      max: 15,
      note: !input.audienceSize && !input.pastClipViews ? "Compte à démarrer de zéro" : undefined,
    },
    {
      key: "brief",
      label: "Clarté du brief",
      raw: `${briefBits}/4 éléments fournis${nicheHits.length ? `, niche ${nicheHits.join("/")}` : ""}`,
      points: clamp(briefBits * 3 + (nicheHits.length ? 3 : 0), 0, 15),
      max: 15,
      note: briefBits <= 1 ? "Brief trop vague : prévoir un appel de cadrage" : undefined,
    },
    {
      key: "payment",
      label: "Paiement",
      raw: input.membershipStatus ?? "inconnu",
      points: input.membershipValid ? 10 : input.membershipStatus === "past_due" ? 3 : 0,
      max: 10,
      note: input.membershipValid ? undefined : "Abonnement non valide : ne pas commencer à produire",
    },
  ];

  const score = clamp(
    components.reduce((s, c) => s + c.points, 0),
    0,
    100,
  );

  // Un prix par clip non viable disqualifie, quel que soit le reste.
  const unviable = pricePerClipCents < MIN_VIABLE_PRICE_PER_CLIP_CENTS;
  const decision: QualificationResult["decision"] = unviable
    ? "refuser"
    : score >= 70
      ? "prendre"
      : score >= 45
        ? "discuter"
        : "refuser";

  const weakest = [...components].sort((a, b) => a.points / a.max - b.points / b.max)[0];
  const strongest = [...components].sort((a, b) => b.points / b.max - a.points / a.max)[0];

  const base = unviable
    ? `${(pricePerClipCents / 100).toFixed(2)} € par clip : en dessous du seuil, le volume demandé coûte plus qu'il ne rapporte.`
    : decision === "prendre"
      ? `À prendre — ${strongest.label.toLowerCase()} au top, ${(pricePerClipCents / 100).toFixed(0)} € par clip.`
      : decision === "discuter"
        ? `À cadrer avant d'accepter — point faible : ${weakest.label.toLowerCase()}.`
        : `À refuser — ${weakest.label.toLowerCase()} rédhibitoire.`;

  // Le dossier peut être bon et l'abonnement impayé : le dire en premier,
  // sinon l'interface annonce « à prendre » sur un client qui ne paie pas.
  const summary =
    input.membershipValid === false
      ? `Abonnement ${input.membershipStatus ?? "non valide"} — ne rien produire tant que le paiement n'est pas régularisé. Sur le fond : ${base.charAt(0).toLowerCase()}${base.slice(1)}`
      : base;

  return { score, components, decision, summary, pricePerClipCents };
}

/**
 * Priorité de production : quel client servir en premier cette semaine.
 * Distincte de la qualification — un bon client déjà livré passe après
 * un client en retard de livraison.
 */
export function productionPriority(input: {
  score: number;
  clipsPerMonth: number;
  clipsDelivered: number;
  mrrCents: number;
  nextDueAt?: Date | null;
  status: string;
}): { priority: number; reason: string } {
  const remaining = Math.max(0, input.clipsPerMonth - input.clipsDelivered);
  const completion = input.clipsPerMonth ? input.clipsDelivered / input.clipsPerMonth : 1;
  const hoursToDue = input.nextDueAt ? (input.nextDueAt.getTime() - Date.now()) / 36e5 : Infinity;

  if (input.status !== "ACTIVE" && input.status !== "TRIAL") {
    return { priority: 0, reason: "Abonnement inactif : rien à produire." };
  }
  if (remaining === 0) {
    return { priority: 5, reason: "Quota du mois déjà livré." };
  }

  // Le retard prime sur tout le reste : une échéance manquée est une
  // promesse rompue, donc un risque de résiliation. 60 points garantissent
  // qu'un retard passe devant le cumul des autres critères (55 au maximum).
  const urgency = hoursToDue < 0 ? 60 : hoursToDue < 24 ? 40 : hoursToDue < 72 ? 20 : 8;
  const backlog = clamp(Math.round((1 - completion) * 25), 0, 25);
  const value = clamp(Math.round((input.mrrCents / 200_000) * 20), 0, 20);
  const quality = clamp(Math.round((input.score / 100) * 10), 0, 10);

  const priority = clamp(urgency + backlog + value + quality, 0, 100);
  const reason =
    hoursToDue < 0
      ? `En retard de ${Math.abs(Math.round(hoursToDue))} h — ${remaining} clip(s) à livrer.`
      : hoursToDue < 24
        ? `Échéance dans ${Math.round(hoursToDue)} h — ${remaining} clip(s) restants.`
        : `${remaining} clip(s) restants sur ${input.clipsPerMonth} ce mois-ci.`;

  return { priority, reason };
}
