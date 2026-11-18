/**
 * « Se connecter avec Whop » — OAuth 2.0 + PKCE.
 *
 *  - Autorisation : https://api.whop.com/oauth/authorize
 *  - Jeton        : https://api.whop.com/oauth/token
 *  - Profil       : https://api.whop.com/oauth/userinfo (Bearer)
 *  - Révocation   : https://api.whop.com/oauth/revoke
 *
 * Les access tokens expirent au bout d'une heure ; les refresh tokens
 * tournent à chaque usage. `client_id` a la forme `app_xxxxx`.
 */
import crypto from "node:crypto";
import { config, live } from "../config";

const AUTHORIZE_URL = "https://api.whop.com/oauth/authorize";
const TOKEN_URL = "https://api.whop.com/oauth/token";
const USERINFO_URL = "https://api.whop.com/oauth/userinfo";

export const DEFAULT_SCOPES = ["openid", "profile", "email"];

export type PkcePair = { verifier: string; challenge: string };

export function createPkce(): PkcePair {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(args: {
  state: string;
  challenge: string;
  scopes?: string[];
  companyId?: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.whop.oauth.clientId);
  url.searchParams.set("redirect_uri", config.whop.oauth.redirectUri);
  url.searchParams.set("scope", (args.scopes ?? DEFAULT_SCOPES).join(" "));
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (args.companyId ?? config.whop.companyId) {
    url.searchParams.set("company_id", args.companyId ?? config.whop.companyId);
  }
  return url.toString();
}

export type WhopTokenSet = {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

export async function exchangeCode(code: string, verifier: string): Promise<WhopTokenSet> {
  if (!live.whopOauth()) {
    return {
      access_token: "mock_access_token",
      refresh_token: "mock_refresh_token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: DEFAULT_SCOPES.join(" "),
    };
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: config.whop.oauth.clientId,
      client_secret: config.whop.oauth.clientSecret,
      redirect_uri: config.whop.oauth.redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Échange du code OAuth Whop refusé (${res.status}) : ${await res.text()}`);
  }
  return (await res.json()) as WhopTokenSet;
}

export type WhopUserInfo = {
  sub: string;
  name?: string;
  email?: string;
  username?: string;
  picture?: string;
};

export async function fetchUserInfo(accessToken: string): Promise<WhopUserInfo> {
  if (!live.whopOauth()) {
    return {
      sub: "user_mock_lena",
      name: "Léna Moreau",
      email: "lena.edits@example.com",
      username: "lena.edits",
    };
  }
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`userinfo Whop → ${res.status}`);
  return (await res.json()) as WhopUserInfo;
}
