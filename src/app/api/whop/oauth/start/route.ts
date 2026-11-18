/** Démarre « Se connecter avec Whop » (OAuth 2.0 + PKCE). */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { buildAuthorizeUrl, createPkce } from "@/lib/whop/oauth";
import { live } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!live.whopOauth()) {
    return NextResponse.json(
      { error: "OAuth Whop non configuré : renseigner WHOP_OAUTH_CLIENT_ID et WHOP_OAUTH_CLIENT_SECRET." },
      { status: 503 },
    );
  }

  const state = crypto.randomBytes(16).toString("base64url");
  const { verifier, challenge } = createPkce();

  const jar = await cookies();
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: true, path: "/", maxAge: 600 };
  jar.set("whop_oauth_state", state, opts);
  jar.set("whop_oauth_verifier", verifier, opts);

  return NextResponse.redirect(buildAuthorizeUrl({ state, challenge }));
}
