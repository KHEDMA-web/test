/**
 * Client Metricool — planification des publications.
 *
 * Références (doc officielle Metricool) :
 *  - Base          : https://app.metricool.com/api
 *  - Création      : POST /v2/scheduler/posts?blogId={blogId}&userId={userId}
 *  - Lecture       : GET  /v2/scheduler/posts/{id}
 *  - Mise à jour   : PUT  /v2/scheduler/posts/{id}
 *  - Suppression   : DELETE /v2/scheduler/posts/{id}
 *  - Marques       : GET  /admin/simpleProfiles?userId={userId}
 *  - Auth          : en-tête `X-Mc-Auth: <userToken>` ; `userId` et `blogId`
 *                    passent en query string, jamais en en-tête.
 *  - Date          : `publicationDate.dateTime` est une date locale SANS
 *                    décalage (2026-08-01T10:00:00) + `timezone` IANA.
 *                    Une date passée renvoie 400.
 *  - Média         : l'URL doit être publique et non expirante, sinon le post
 *                    est planifié sans média.
 *
 * Point de divergence documentaire assumé : le guide « Basic Guide for API
 * Integration » décrit `media` comme un objet `{ mediaId }`, la page White
 * Label comme un tableau de chaînes. Le format est donc réglable
 * (`mediaMode`) au lieu d'être deviné ; la valeur par défaut est le tableau
 * d'URL, qui fonctionne avec `saveExternalMediaFiles`.
 */
import { config, live } from "../config";
import { metricoolMock } from "./mock";

const BASE_URL = "https://app.metricool.com/api";

export type MetricoolNetwork =
  | "instagram"
  | "tiktok"
  | "youtube"
  | "facebook"
  | "linkedin"
  | "twitter"
  | "pinterest"
  | "gmb"
  | "threads"
  | "bluesky";

export type MediaMode = "array" | "mediaId";

export type SchedulePostInput = {
  /** Date locale sans décalage : 2026-08-01T10:00:00 */
  dateTimeLocal: string;
  timezone?: string;
  text: string;
  networks: MetricoolNetwork[];
  blogId?: string;
  mediaUrl?: string | null;
  mediaId?: string | null;
  mediaMode?: MediaMode;
  autoPublish?: boolean;
  draft?: boolean;
  firstCommentText?: string | null;
  shortener?: boolean;
  saveExternalMediaFiles?: boolean;
  creatorUserMail?: string | null;
  /** Blocs spécifiques réseau : facebookData, tiktokData, youtubeData... */
  networkData?: Record<string, unknown>;
};

export type MetricoolPost = {
  id?: string | number;
  [key: string]: unknown;
};

export class MetricoolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
    /** Une erreur non récupérable ne doit pas être rejouée. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "MetricoolError";
  }
}

function explain(status: number, body: unknown): { message: string; retryable: boolean } {
  switch (status) {
    case 400:
      return {
        message:
          "Requête refusée (400) : date de publication dans le passé, ou `publicationDate`/`text`/`providers` manquant.",
        retryable: false,
      };
    case 401:
      return { message: "Non authentifié (401) : METRICOOL_USER_TOKEN absent ou invalide.", retryable: false };
    case 403:
      return {
        message:
          "Accès refusé (403) : jeton sans droit sur cette marque, ou appel direct depuis un navigateur (préflight CORS). Les appels doivent partir du serveur.",
        retryable: false,
      };
    case 404:
      return { message: "Ressource introuvable (404) : vérifier blogId et l'identifiant du post.", retryable: false };
    case 429:
      return { message: "Quota atteint (429) : réessayer plus tard.", retryable: true };
    default:
      if (status >= 500) return { message: `Erreur serveur Metricool (${status}).`, retryable: true };
      return { message: `Metricool a répondu ${status} : ${JSON.stringify(body).slice(0, 300)}`, retryable: false };
  }
}

async function request<T>(
  path: string,
  init: { method?: string; query?: Record<string, string | undefined>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(BASE_URL + path);
  // userId et blogId voyagent en query string — exigence de l'API.
  url.searchParams.set("userId", config.metricool.userId);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, v);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        "X-Mc-Auth": config.metricool.userToken,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch (err) {
    // Panne réseau : rejouable.
    throw new MetricoolError(`Metricool injoignable : ${(err as Error).message}`, 0, null, true);
  }

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* réponse non JSON : on garde le texte brut */
  }

  if (!res.ok) {
    const { message, retryable } = explain(res.status, parsed);
    throw new MetricoolError(message, res.status, parsed, retryable);
  }
  return parsed as T;
}

/** Construit le corps exact envoyé à Metricool (exposé pour l'audit et les tests). */
export function buildSchedulePayload(input: SchedulePostInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    publicationDate: {
      dateTime: input.dateTimeLocal,
      timezone: input.timezone ?? config.metricool.timezone,
    },
    text: input.text,
    providers: input.networks.map((network) => ({ network })),
    autoPublish: input.autoPublish ?? true,
    draft: input.draft ?? false,
    shortener: input.shortener ?? false,
    // Metricool ne télécharge le média que si on le lui demande explicitement.
    saveExternalMediaFiles: input.saveExternalMediaFiles ?? true,
  };

  if (input.firstCommentText) payload.firstCommentText = input.firstCommentText;
  if (input.creatorUserMail) payload.creatorUserMail = input.creatorUserMail;

  const mode = input.mediaMode ?? "array";
  if (input.mediaId) {
    payload.media = { mediaId: input.mediaId };
  } else if (input.mediaUrl) {
    payload.media = mode === "array" ? [input.mediaUrl] : { mediaId: input.mediaUrl };
  }

  for (const [key, value] of Object.entries(input.networkData ?? {})) {
    payload[key] = value;
  }

  return payload;
}

export const metricool = {
  mode: () => (live.metricool() ? ("live" as const) : ("mock" as const)),

  /** Marques du compte : donne les `blogId` utilisables. */
  async listBrands(): Promise<Array<{ blogId: string; label: string }>> {
    if (!live.metricool()) return metricoolMock.listBrands();
    const data = await request<unknown>("/admin/simpleProfiles");
    const rows = Array.isArray(data) ? data : ((data as { data?: unknown[] })?.data ?? []);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      blogId: String(r.blogId ?? r.id ?? ""),
      label: String(r.label ?? r.title ?? r.name ?? r.url ?? "Marque"),
    }));
  },

  /**
   * Prépare un média distant. Metricool expose une action de normalisation
   * d'image ; aucun endpoint d'upload vidéo n'est documenté, donc pour une
   * vidéo on transmet l'URL publique telle quelle avec
   * `saveExternalMediaFiles: true`.
   */
  async normalizeImage(url: string): Promise<string> {
    if (!live.metricool()) return metricoolMock.normalizeImage(url);
    const res = await request<unknown>(`/actions/normalize/image/url`, { query: { url } });
    if (typeof res === "string") return res;
    const obj = res as Record<string, unknown>;
    return String(obj.url ?? obj.mediaId ?? obj.data ?? url);
  },

  async schedulePost(input: SchedulePostInput): Promise<{ id: string | null; raw: MetricoolPost; payload: Record<string, unknown> }> {
    const payload = buildSchedulePayload(input);
    const blogId = input.blogId ?? config.metricool.blogId;

    if (!live.metricool()) {
      const raw = await metricoolMock.schedulePost(payload, blogId);
      return { id: String(raw.id), raw, payload };
    }

    const raw = await request<MetricoolPost>("/v2/scheduler/posts", {
      method: "POST",
      query: { blogId },
      body: payload,
    });
    const id = raw?.id !== undefined ? String(raw.id) : null;
    return { id, raw, payload };
  },

  async getPost(id: string, blogId?: string): Promise<MetricoolPost | null> {
    if (!live.metricool()) return metricoolMock.getPost(id);
    try {
      return await request<MetricoolPost>(`/v2/scheduler/posts/${encodeURIComponent(id)}`, {
        query: { blogId: blogId ?? config.metricool.blogId },
      });
    } catch (err) {
      if (err instanceof MetricoolError && err.status === 404) return null;
      throw err;
    }
  },

  async deletePost(id: string, blogId?: string): Promise<void> {
    if (!live.metricool()) {
      await metricoolMock.deletePost(id);
      return;
    }
    await request(`/v2/scheduler/posts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      query: { blogId: blogId ?? config.metricool.blogId },
    });
  },
};
