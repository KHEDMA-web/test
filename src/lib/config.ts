/**
 * Configuration centrale.
 *
 * Règle : chaque intégration est « réelle » dès que ses clés sont présentes,
 * sinon elle bascule en mock. Ça permet d'exécuter le flux complet
 * rush → publication sans aucune clé, puis de passer en production
 * clé par clé, sans toucher au code.
 */

function env(key: string, fallback = ""): string {
  const v = process.env[key];
  return v === undefined || v === null ? fallback : v;
}

const forceMock = env("CLIPFLOW_MOCK", "0") === "1";

export const config = {
  forceMock,

  storageDir: env("CLIPFLOW_STORAGE_DIR", "./storage"),
  publicBaseUrl: env("CLIPFLOW_PUBLIC_BASE_URL", "http://localhost:3000"),

  whop: {
    apiKey: env("WHOP_API_KEY"),
    apiVersionDate: env("WHOP_API_VERSION_DATE", "2026-11-04-1"),
    environment: env("WHOP_ENV", "production") as "production" | "sandbox",
    webhookSecret: env("WHOP_WEBHOOK_SECRET"),
    companyId: env("WHOP_COMPANY_ID"),
    productId: env("WHOP_PRODUCT_ID"),
    oauth: {
      clientId: env("WHOP_OAUTH_CLIENT_ID"),
      clientSecret: env("WHOP_OAUTH_CLIENT_SECRET"),
      redirectUri: env("WHOP_OAUTH_REDIRECT_URI", "http://localhost:3000/api/whop/oauth/callback"),
    },
  },

  transcription: {
    provider: env("TRANSCRIPTION_PROVIDER", "mock") as
      | "mock"
      | "openai"
      | "deepgram"
      | "local-whisper",
    openaiKey: env("OPENAI_API_KEY"),
    deepgramKey: env("DEEPGRAM_API_KEY"),
  },

  hooks: {
    provider: env("HOOKS_PROVIDER", "heuristic") as "heuristic" | "anthropic",
    anthropicKey: env("ANTHROPIC_API_KEY"),
    anthropicModel: env("ANTHROPIC_MODEL", "claude-opus-5-5"),
  },

  metricool: {
    userToken: env("METRICOOL_USER_TOKEN"),
    userId: env("METRICOOL_USER_ID"),
    blogId: env("METRICOOL_BLOG_ID"),
    timezone: env("METRICOOL_TIMEZONE", "Europe/Paris"),
  },
} as const;

/** Une intégration est live si ses secrets sont là et que le mock n'est pas forcé. */
export const live = {
  whop: () => !config.forceMock && config.whop.apiKey.length > 0,
  whopWebhook: () => config.whop.webhookSecret.length > 0,
  whopOauth: () =>
    !config.forceMock &&
    config.whop.oauth.clientId.length > 0 &&
    config.whop.oauth.clientSecret.length > 0,
  transcription: () => {
    if (config.forceMock) return false;
    switch (config.transcription.provider) {
      case "openai":
        return config.transcription.openaiKey.length > 0;
      case "deepgram":
        return config.transcription.deepgramKey.length > 0;
      case "local-whisper":
        return true;
      default:
        return false;
    }
  },
  hooksLlm: () =>
    !config.forceMock &&
    config.hooks.provider === "anthropic" &&
    config.hooks.anthropicKey.length > 0,
  metricool: () =>
    !config.forceMock &&
    config.metricool.userToken.length > 0 &&
    config.metricool.userId.length > 0,
};

export type IntegrationStatus = {
  key: string;
  label: string;
  stage: string;
  mode: "live" | "mock";
  missing: string[];
  docs: string;
};

/** Utilisé par /settings pour montrer l'état réel de chaque étage. */
export function integrationStatuses(): IntegrationStatus[] {
  const miss = (pairs: Array<[string, string]>) =>
    pairs.filter(([, v]) => !v).map(([k]) => k);

  return [
    {
      key: "whop",
      label: "Whop — API (recrutement, memberships)",
      stage: "1 · Recrutement",
      mode: live.whop() ? "live" : "mock",
      missing: miss([["WHOP_API_KEY", config.whop.apiKey]]),
      docs: "https://docs.whop.com/developer/api/quickstart",
    },
    {
      key: "whop-webhook",
      label: "Whop — webhooks signés (Standard Webhooks)",
      stage: "1 · Recrutement",
      mode: live.whopWebhook() ? "live" : "mock",
      missing: miss([["WHOP_WEBHOOK_SECRET", config.whop.webhookSecret]]),
      docs: "https://docs.whop.com/developer/guides/webhooks",
    },
    {
      key: "whop-oauth",
      label: "Whop — connexion des clippers (OAuth)",
      stage: "1 · Recrutement",
      mode: live.whopOauth() ? "live" : "mock",
      missing: miss([
        ["WHOP_OAUTH_CLIENT_ID", config.whop.oauth.clientId],
        ["WHOP_OAUTH_CLIENT_SECRET", config.whop.oauth.clientSecret],
      ]),
      docs: "https://docs.whop.com/developer/guides/oauth",
    },
    {
      key: "transcription",
      label: `Transcription — ${config.transcription.provider}`,
      stage: "2 · Rush",
      mode: live.transcription() ? "live" : "mock",
      missing:
        config.transcription.provider === "openai"
          ? miss([["OPENAI_API_KEY", config.transcription.openaiKey]])
          : config.transcription.provider === "deepgram"
            ? miss([["DEEPGRAM_API_KEY", config.transcription.deepgramKey]])
            : config.transcription.provider === "mock"
              ? ["TRANSCRIPTION_PROVIDER"]
              : [],
      docs: "https://platform.openai.com/docs/guides/speech-to-text",
    },
    {
      key: "hooks",
      label: `Hooks — ${live.hooksLlm() ? "Claude" : "heuristique"}`,
      stage: "3 · Moments & hooks",
      mode: live.hooksLlm() ? "live" : "mock",
      missing: miss([["ANTHROPIC_API_KEY", config.hooks.anthropicKey]]),
      docs: "https://docs.claude.com/en/api/messages",
    },
    {
      key: "metricool",
      label: "Metricool — planification des publications",
      stage: "5 · Publication",
      mode: live.metricool() ? "live" : "mock",
      missing: miss([
        ["METRICOOL_USER_TOKEN", config.metricool.userToken],
        ["METRICOOL_USER_ID", config.metricool.userId],
        ["METRICOOL_BLOG_ID", config.metricool.blogId],
      ]),
      docs: "https://help.metricool.com/basic-guide-for-api-integration-r97af",
    },
  ];
}
