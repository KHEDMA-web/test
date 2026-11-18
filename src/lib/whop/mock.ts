/**
 * Clients fictifs en mode mock : des gens qui paient un abonnement de
 * clipping. Volontairement contrastés — un gros compte bien équipé, un
 * client qui demande trop de volume pour trop peu, un prospect sans
 * matière — pour que la qualification trie vraiment.
 */
import type { WhopMembershipDTO } from "./client";

const CLIENTS = [
  {
    user: "user_mock_nova",
    username: "nova.studio",
    name: "Nova Studio",
    email: "contact@novastudio.example",
    status: "active",
    plan: "Clipping Pro — 20 clips/mois",
    mrrCents: 149_000,
    clipsPerMonth: 20,
    backCatalogHours: 120,
    sourcing: "CLIENT_PROVIDED",
    audience: 310_000,
    pastViews: 4_800_000,
    niches: ["business", "podcast"],
    networks: ["instagram", "tiktok", "youtube"],
    brief:
      "Podcast business hebdomadaire, épisodes de 90 minutes. On veut des clips qui tiennent seuls, pas d'extraits qui dépendent du contexte.",
    hooks: "Pas de majuscules criées, pas d'emoji. Privilégier les chiffres cités dans l'épisode.",
  },
  {
    user: "user_mock_hugo",
    username: "hugo.coach",
    name: "Hugo Lemaire",
    email: "hugo@coachlemaire.example",
    status: "active",
    plan: "Clipping Essentiel — 8 clips/mois",
    mrrCents: 49_000,
    clipsPerMonth: 8,
    backCatalogHours: 40,
    sourcing: "SELF_SOURCED",
    audience: 24_000,
    pastViews: 390_000,
    niches: ["mindset", "fitness"],
    networks: ["instagram", "tiktok"],
    brief: "Lives Twitch et YouTube. Je n'ai pas le temps de trier, vous prenez ce qui vous semble bon.",
    hooks: "Ton direct, tutoiement.",
  },
  {
    user: "user_mock_atlas",
    username: "atlas.saas",
    name: "Atlas SaaS",
    email: "marketing@atlas.example",
    status: "trialing",
    plan: "Clipping Pro — 15 clips/mois",
    mrrCents: 99_000,
    clipsPerMonth: 15,
    backCatalogHours: 18,
    sourcing: "MIXED",
    audience: 8_900,
    pastViews: 62_000,
    niches: ["tech", "business"],
    networks: ["linkedin", "youtube"],
    brief: "Webinaires produit. Cible B2B, pas de ton familier.",
    hooks: "Rester factuel, mettre en avant les résultats chiffrés.",
  },
  {
    user: "user_mock_kayo",
    username: "kayo.music",
    name: "Kayo",
    email: "kayo@label.example",
    status: "active",
    plan: "Volume — 40 clips/mois",
    mrrCents: 39_000,
    clipsPerMonth: 40,
    backCatalogHours: 200,
    sourcing: "CLIENT_PROVIDED",
    audience: 95_000,
    pastViews: 1_200_000,
    niches: ["musique"],
    networks: ["tiktok", "instagram"],
    brief: "Sessions studio, beaucoup de matière, on veut du volume.",
    hooks: "",
  },
  {
    user: "user_mock_sora",
    username: "sora.launch",
    name: "Sora Launch",
    email: "hello@soralaunch.example",
    status: "active",
    plan: "Clipping Essentiel — 6 clips/mois",
    mrrCents: 39_000,
    clipsPerMonth: 6,
    backCatalogHours: 0,
    sourcing: "SELF_SOURCED",
    audience: 450,
    pastViews: 0,
    niches: ["lifestyle"],
    networks: ["tiktok"],
    brief: "",
    hooks: "",
  },
  {
    user: "user_mock_veritas",
    username: "veritas.pod",
    name: "Veritas Podcast",
    email: "prod@veritas.example",
    status: "past_due",
    plan: "Clipping Pro — 12 clips/mois",
    mrrCents: 89_000,
    clipsPerMonth: 12,
    backCatalogHours: 75,
    sourcing: "CLIENT_PROVIDED",
    audience: 56_000,
    pastViews: 820_000,
    niches: ["podcast", "société"],
    networks: ["youtube", "instagram"],
    brief: "Entretiens longs, sujets de société.",
    hooks: "Pas de sensationnalisme, le hook doit être tenu par le propos.",
  },
];

export const MOCK_CLIENTS = CLIENTS;

export async function mockMemberships(productId?: string): Promise<WhopMembershipDTO[]> {
  const prod = productId || "prod_mock_clipping";
  return CLIENTS.map((c, i) => ({
    id: `mem_mock_${i + 1}`,
    userId: c.user,
    productId: prod,
    planId: `plan_${c.clipsPerMonth}`,
    accountId: "biz_mock_clipflow",
    status: c.status,
    valid: c.status === "active" || c.status === "trialing",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date(Date.now() + 26 * 864e5),
    email: c.email,
    username: c.username,
    name: c.name,
    metadata: {
      plan_name: c.plan,
      mrr_cents: c.mrrCents,
      clips_per_month: c.clipsPerMonth,
      back_catalog_hours: c.backCatalogHours,
      sourcing: c.sourcing,
      audience_size: c.audience,
      past_clip_views: c.pastViews,
      niches: c.niches,
      networks: c.networks,
      brief: c.brief,
      hook_guidelines: c.hooks,
    },
    raw: { mock: true, source: "whop-mock" },
  }));
}

export async function mockWhopUser(id: string) {
  const c = CLIENTS.find((x) => x.user === id);
  return {
    id,
    username: c?.username ?? "unknown",
    name: c?.name ?? "Utilisateur inconnu",
    email: c?.email ?? null,
    mock: true,
  };
}
