/**
 * Retour OAuth Whop : échange du code, lecture du profil, création ou
 * rattachement du compte local, puis vérification de l'accès au produit
 * « clippers » (un membership valide vaut autorisation).
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { exchangeCode, fetchUserInfo } from "@/lib/whop/oauth";
import { whop } from "@/lib/whop/client";
import { logEvent } from "@/lib/log";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) return NextResponse.json({ error }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Code d'autorisation absent." }, { status: 400 });

  const jar = await cookies();
  const expectedState = jar.get("whop_oauth_state")?.value;
  const verifier = jar.get("whop_oauth_verifier")?.value;

  if (!expectedState || state !== expectedState) {
    return NextResponse.json({ error: "State invalide : tentative rejetée." }, { status: 400 });
  }
  if (!verifier) {
    return NextResponse.json({ error: "Vérificateur PKCE absent ou expiré." }, { status: 400 });
  }

  const tokens = await exchangeCode(code, verifier);
  const profile = await fetchUserInfo(tokens.access_token);

  const email = profile.email ?? `${profile.sub}@whop.local`;
  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      name: profile.name ?? profile.username ?? email.split("@")[0],
      role: "CLIENT",
      whopUserId: profile.sub,
      whopUsername: profile.username,
      avatarUrl: profile.picture,
    },
    update: { whopUserId: profile.sub, whopUsername: profile.username, avatarUrl: profile.picture },
  });

  const hasAccess = await whop.hasAccess(profile.sub, config.whop.productId).catch(() => false);
  // Un abonnement valide = un client payant : on le rattache à sa fiche.
  if (hasAccess) {
    await prisma.client.updateMany({ where: { whopUserId: profile.sub }, data: { userId: user.id } });
  }

  await logEvent({
    stage: "whop",
    entity: `user:${user.id}`,
    message: `Connexion Whop de ${user.name}${hasAccess ? " (abonnement valide)" : " (aucun abonnement valide)"}`,
  });

  jar.delete("whop_oauth_state");
  jar.delete("whop_oauth_verifier");

  return NextResponse.redirect(new URL(hasAccess ? "/clients" : "/", url.origin));
}
