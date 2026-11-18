/**
 * Client Whop — API v1.
 *
 * Références :
 *  - Base prod    : https://api.whop.com/api/v1
 *  - Base sandbox : https://sandbox-api.whop.com/api/v1
 *  - Auth         : en-tête `Authorization: Bearer <API_KEY>` (serveur uniquement)
 *  - Versionnage  : en-tête `Api-Version-Date` (sinon les formes 2025-01-01 s'appliquent)
 *  - Pagination   : { data: [...], page_info: { end_cursor, has_next_page } }
 *
 * Note honnête sur les chemins : la doc publique décrit les opérations via le SDK
 * (`client.memberships.list({ account_id })`) et ne donne pas tous les chemins HTTP
 * bruts. Les chemins ci-dessous (/memberships, /users/{id}) suivent la convention
 * REST de l'API et sont centralisés dans WHOP_PATHS pour être corrigés en un point
 * si la spec OpenAPI (https://api.whop.com/api/v1/openapi.json) diffère.
 */
import { config, live } from "../config";
import { mockMemberships, mockWhopUser } from "./mock";

export const WHOP_PATHS = {
  memberships: "/memberships",
  membership: (id: string) => `/memberships/${id}`,
  membershipExtend: (id: string) => `/memberships/${id}/extend`,
  users: "/users",
  user: (id: string) => `/users/${id}`,
  webhooks: "/webhooks",
} as const;

export type WhopPageInfo = {
  end_cursor?: string | null;
  has_next_page?: boolean;
};

export type WhopList<T> = { data: T[]; page_info?: WhopPageInfo };

/**
 * Membership Whop, normalisé.
 *
 * Le schéma exact du payload n'est pas publié dans les pages de doc accessibles
 * (seuls `status`, `cancel_at_period_end`, `current_period_end`, `metadata` sont
 * cités explicitement). `normalizeMembership` accepte donc plusieurs variantes.
 */
export type WhopMembershipDTO = {
  id: string;
  userId: string | null;
  productId: string | null;
  planId: string | null;
  accountId: string | null;
  status: string;
  valid: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: Date | null;
  email: string | null;
  username: string | null;
  name: string | null;
  metadata: Record<string, unknown> | null;
  raw: Record<string, unknown>;
};

export class WhopError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "WhopError";
  }
}

function baseUrl(): string {
  return config.whop.environment === "sandbox"
    ? "https://sandbox-api.whop.com/api/v1"
    : "https://api.whop.com/api/v1";
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "id" in (v as Record<string, unknown>)) {
    const id = (v as Record<string, unknown>).id;
    return typeof id === "string" ? id : null;
  }
  return null;
}

/** Statuts Whop qui donnent accès (`valid` n'est pas toujours présent). */
const VALID_STATUSES = new Set(["active", "trialing", "completed"]);

export function normalizeMembership(raw: Record<string, unknown>): WhopMembershipDTO {
  const user = (raw.user ?? raw.member ?? {}) as Record<string, unknown>;
  const status = String(pick(raw, ["status", "state"]) ?? "unknown");
  const rawValid = pick(raw, ["valid", "is_valid"]);

  return {
    id: String(pick(raw, ["id", "membership_id"]) ?? ""),
    userId: asString(pick(raw, ["user_id", "user", "member_id"])),
    productId: asString(pick(raw, ["product_id", "product", "access_pass_id", "access_pass"])),
    planId: asString(pick(raw, ["plan_id", "plan"])),
    accountId: asString(pick(raw, ["account_id", "company_id"])),
    status,
    valid: typeof rawValid === "boolean" ? rawValid : VALID_STATUSES.has(status),
    cancelAtPeriodEnd: Boolean(pick(raw, ["cancel_at_period_end", "cancelAtPeriodEnd"])),
    currentPeriodEnd: toDate(pick(raw, ["current_period_end", "renewal_period_end", "expires_at"])),
    email: (pick(raw, ["email", "user_email"]) as string | undefined) ?? (user.email as string) ?? null,
    username: (pick(raw, ["username"]) as string | undefined) ?? (user.username as string) ?? null,
    name: (pick(raw, ["name"]) as string | undefined) ?? (user.name as string) ?? null,
    metadata: (raw.metadata as Record<string, unknown> | undefined) ?? null,
    raw,
  };
}

function toDate(v: unknown): Date | null {
  if (v === undefined || v === null) return null;
  // Whop renvoie selon les ressources un ISO string ou un epoch (s ou ms).
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== "") return new Date(n < 1e12 ? n * 1000 : n);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function request<T>(
  path: string,
  init: { method?: string; query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.whop.apiKey}`,
      "Api-Version-Date": config.whop.apiVersionDate,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });

  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new WhopError(
      `Whop ${init.method ?? "GET"} ${path} → ${res.status}`,
      res.status,
      parsed ?? text,
    );
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const whop = {
  mode: () => (live.whop() ? ("live" as const) : ("mock" as const)),

  /** Memberships d'un produit / d'un compte, toutes pages confondues. */
  async listMemberships(opts: { productId?: string; limit?: number } = {}): Promise<WhopMembershipDTO[]> {
    if (!live.whop()) return mockMemberships(opts.productId ?? config.whop.productId);

    const out: WhopMembershipDTO[] = [];
    let after: string | undefined;
    const hardLimit = opts.limit ?? 500;

    do {
      const page = await request<WhopList<Record<string, unknown>>>(WHOP_PATHS.memberships, {
        query: {
          account_id: config.whop.companyId || undefined,
          product_id: opts.productId ?? config.whop.productId ?? undefined,
          after,
        },
      });
      for (const row of page.data ?? []) out.push(normalizeMembership(row));
      after = page.page_info?.has_next_page ? (page.page_info.end_cursor ?? undefined) : undefined;
    } while (after && out.length < hardLimit);

    return out;
  },

  async getMembership(id: string): Promise<WhopMembershipDTO | null> {
    if (!live.whop()) {
      const all = await mockMemberships(config.whop.productId);
      return all.find((m) => m.id === id) ?? null;
    }
    try {
      const row = await request<Record<string, unknown>>(WHOP_PATHS.membership(id));
      return normalizeMembership(row);
    } catch (err) {
      if (err instanceof WhopError && err.status === 404) return null;
      throw err;
    }
  },

  /**
   * Un utilisateur a-t-il accès au produit « clippers » ?
   * La doc ne publie pas de chemin d'access-check dédié : on tranche sur les
   * memberships, ce qui est la source de vérité de toute façon.
   */
  async hasAccess(whopUserId: string, productId?: string): Promise<boolean> {
    const target = productId ?? config.whop.productId;
    const memberships = await this.listMemberships({ productId: target });
    return memberships.some((m) => m.userId === whopUserId && m.valid);
  },

  async getUser(whopUserId: string) {
    if (!live.whop()) return mockWhopUser(whopUserId);
    return request<Record<string, unknown>>(WHOP_PATHS.user(whopUserId));
  },

  /** Enregistre l'endpoint webhook. Le `webhook_secret` n'est renvoyé qu'une fois. */
  async createWebhook(url: string, events: string[]) {
    if (!live.whop()) {
      return { id: "wh_mock", url, events, webhook_secret: "ws_mock_secret_never_used" };
    }
    return request<Record<string, unknown>>(WHOP_PATHS.webhooks, {
      method: "POST",
      body: { url, events },
    });
  },
};
