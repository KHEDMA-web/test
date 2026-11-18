/**
 * Vérification des webhooks Whop — spécification Standard Webhooks.
 *
 *  - En-têtes : `webhook-id`, `webhook-timestamp`, `webhook-signature`
 *  - Contenu signé : `{webhook-id}.{webhook-timestamp}.{raw body}`
 *  - HMAC-SHA256, clé = la chaîne complète du secret `ws_...`
 *    (ne pas retirer le préfixe, ne pas décoder en base64)
 *  - `webhook-signature` vaut `v1,<base64>` et peut contenir plusieurs
 *    signatures séparées par des espaces (rotation de secret)
 *  - Rejeter si l'horodatage s'écarte de plus de 5 minutes
 *  - Livraison at-least-once : dédupliquer sur `webhook-id`
 *
 * Implémenté ici plutôt qu'avec `unwrapWebhook` du SDK pour ne pas dépendre
 * d'un paquet supplémentaire sur un calcul de 20 lignes — et pour que la
 * vérification reste lisible et testable.
 */
import crypto from "node:crypto";

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WhopWebhookEnvelope<T = Record<string, unknown>> = {
  id: string;
  type: string;
  api_version?: string;
  api_version_date?: string;
  timestamp?: string;
  /** `account_id` depuis la version 2026-08-14, `company_id` avant. */
  account_id?: string;
  company_id?: string;
  data: T;
  previous_attributes?: Record<string, unknown>;
};

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export function signPayload(secret: string, id: string, timestamp: string, body: string): string {
  const signed = `${id}.${timestamp}.${body}`;
  return crypto.createHmac("sha256", secret).update(signed, "utf8").digest("base64");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Vérifie la signature et renvoie l'enveloppe parsée.
 * `rawBody` doit être le corps brut : parser d'abord change les octets et
 * fait échouer la vérification.
 */
export function verifyWhopWebhook<T = Record<string, unknown>>(args: {
  rawBody: string;
  headers: Headers | Record<string, string | undefined>;
  secret: string;
  now?: Date;
}): WhopWebhookEnvelope<T> {
  const header = (name: string): string | undefined => {
    if (args.headers instanceof Headers) return args.headers.get(name) ?? undefined;
    const map = args.headers as Record<string, string | undefined>;
    return map[name] ?? map[name.toLowerCase()] ?? map[name.toUpperCase()];
  };

  const id = header("webhook-id");
  const timestamp = header("webhook-timestamp");
  const signature = header("webhook-signature");

  if (!id || !timestamp || !signature) {
    throw new WebhookVerificationError(
      "En-têtes manquants : webhook-id, webhook-timestamp et webhook-signature sont requis.",
    );
  }
  if (!args.secret) {
    throw new WebhookVerificationError("WHOP_WEBHOOK_SECRET absent.");
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    throw new WebhookVerificationError("webhook-timestamp invalide.");
  }
  const nowSec = Math.floor((args.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    throw new WebhookVerificationError(
      `Horodatage hors tolérance (${Math.abs(nowSec - ts)} s > ${WEBHOOK_TOLERANCE_SECONDS} s).`,
    );
  }

  const expected = signPayload(args.secret, id, timestamp, args.rawBody);
  // Plusieurs signatures possibles, séparées par des espaces : « v1,aaa v1,bbb ».
  const provided = signature
    .split(" ")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith("v1,") ? part.slice(3) : part));

  if (!provided.some((sig) => timingSafeEqual(sig, expected))) {
    throw new WebhookVerificationError("Signature invalide.");
  }

  let parsed: WhopWebhookEnvelope<T>;
  try {
    parsed = JSON.parse(args.rawBody) as WhopWebhookEnvelope<T>;
  } catch {
    throw new WebhookVerificationError("Corps JSON illisible.");
  }
  if (!parsed?.type) throw new WebhookVerificationError("Champ `type` absent de l'enveloppe.");
  return parsed;
}

/** Événements Whop auxquels ClipFlow s'abonne. */
export const SUBSCRIBED_EVENTS = [
  "membership.activated",
  "membership.updated",
  "membership.deactivated",
  "membership.went_valid",
  "membership.went_invalid",
  "membership.cancel_at_period_end_changed",
  "payment.succeeded",
] as const;

/**
 * La doc est contradictoire sur les noms exacts (le guide webhooks liste
 * activated/trial_ending_soon/updated, la référence API ajoute deactivated et
 * went_valid/went_invalid). On traite donc toute la famille `membership.*`
 * de la même façon : l'état est recalculé depuis le payload, pas depuis
 * le nom de l'événement.
 */
export function isMembershipEvent(type: string): boolean {
  return type.startsWith("membership.") || type.startsWith("app_membership.");
}
