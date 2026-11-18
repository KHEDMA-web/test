/**
 * Jeu de données Whop en mode mock.
 * Forme identique à la normalisation du client réel, pour que basculer
 * en live ne change rien au code appelant.
 */
import type { WhopMembershipDTO } from "./client";

const CANDIDATES = [
  {
    user: "user_mock_lena",
    username: "lena.edits",
    name: "Léna Moreau",
    email: "lena.edits@example.com",
    status: "active",
    niches: ["business", "mindset"],
    tools: ["CapCut", "After Effects"],
    followers: 24500,
    pastViews: 1850000,
    portfolio: ["https://example.com/lena/1", "https://example.com/lena/2", "https://example.com/lena/3"],
  },
  {
    user: "user_mock_yanis",
    username: "yanisclips",
    name: "Yanis Berrada",
    email: "yanisclips@example.com",
    status: "active",
    niches: ["fitness", "podcast"],
    tools: ["Premiere Pro", "CapCut"],
    followers: 8300,
    pastViews: 640000,
    portfolio: ["https://example.com/yanis/1", "https://example.com/yanis/2"],
  },
  {
    user: "user_mock_sofia",
    username: "sofia.vrt",
    name: "Sofia Vieira",
    email: "sofia.vrt@example.com",
    status: "trialing",
    niches: ["tech", "business"],
    tools: ["DaVinci Resolve"],
    followers: 1200,
    pastViews: 95000,
    portfolio: ["https://example.com/sofia/1"],
  },
  {
    user: "user_mock_karim",
    username: "karimcuts",
    name: "Karim Haddad",
    email: "karimcuts@example.com",
    status: "active",
    niches: ["podcast", "mindset", "business"],
    tools: ["CapCut", "Premiere Pro", "After Effects"],
    followers: 56000,
    pastViews: 4200000,
    portfolio: [
      "https://example.com/karim/1",
      "https://example.com/karim/2",
      "https://example.com/karim/3",
      "https://example.com/karim/4",
    ],
  },
  {
    user: "user_mock_ines",
    username: "ines.media",
    name: "Inès Fabre",
    email: "ines.media@example.com",
    status: "past_due",
    niches: ["lifestyle"],
    tools: ["CapCut"],
    followers: 430,
    pastViews: 12000,
    portfolio: [],
  },
  {
    user: "user_mock_tom",
    username: "tomshorts",
    name: "Tom Rivière",
    email: "tomshorts@example.com",
    status: "active",
    niches: ["business", "tech"],
    tools: ["CapCut", "Final Cut Pro"],
    followers: 15800,
    pastViews: 1120000,
    portfolio: ["https://example.com/tom/1", "https://example.com/tom/2"],
  },
];

export const MOCK_CANDIDATES = CANDIDATES;

export async function mockMemberships(productId?: string): Promise<WhopMembershipDTO[]> {
  const prod = productId || "prod_mock_clippers";
  return CANDIDATES.map((c, i) => ({
    id: `mem_mock_${i + 1}`,
    userId: c.user,
    productId: prod,
    planId: "plan_mock_clipper",
    accountId: "biz_mock_clipflow",
    status: c.status,
    valid: c.status === "active" || c.status === "trialing",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date(Date.now() + 30 * 864e5),
    email: c.email,
    username: c.username,
    name: c.name,
    metadata: {
      niches: c.niches,
      tools: c.tools,
      followers: c.followers,
      past_clip_views: c.pastViews,
      portfolio: c.portfolio,
    },
    raw: { mock: true, source: "whop-mock" },
  }));
}

export async function mockWhopUser(id: string) {
  const c = CANDIDATES.find((x) => x.user === id);
  return {
    id,
    username: c?.username ?? "unknown",
    name: c?.name ?? "Utilisateur inconnu",
    email: c?.email ?? null,
    mock: true,
  };
}
