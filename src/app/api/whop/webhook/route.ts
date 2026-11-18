/**
 * Réception des webhooks Whop.
 *
 * Contraintes de la plateforme respectées ici :
 *  - la signature se vérifie sur le CORPS BRUT (parser d'abord casse la vérif)
 *  - livraison at-least-once → déduplication sur l'en-tête `webhook-id`
 *  - répondre 2xx en moins de 5 secondes, sinon la livraison est rejouée
 *  - l'état du membership est recalculé depuis le payload, jamais déduit
 *    du seul nom de l'événement (la doc publique est contradictoire sur
 *    les noms exacts de la famille `membership.*`)
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { config, live } from "@/lib/config";
import { logEvent } from "@/lib/log";
import { verifyWhopWebhook, WebhookVerificationError, isMembershipEvent } from "@/lib/whop/webhook";
import { normalizeMembership } from "@/lib/whop/client";
import { upsertMembership } from "@/lib/whop/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const rawBody = await req.text();

  if (!live.whopWebhook()) {
    return NextResponse.json(
      { error: "WHOP_WEBHOOK_SECRET non configuré : les webhooks sont refusés tant que la signature ne peut pas être vérifiée." },
      { status: 503 },
    );
  }

  let envelope;
  try {
    envelope = verifyWhopWebhook({
      rawBody,
      headers: req.headers,
      secret: config.whop.webhookSecret,
    });
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      await logEvent({ stage: "whop", entity: "webhook", level: "warn", message: `Webhook rejeté : ${err.message}` });
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    throw err;
  }

  // Déduplication : la même livraison peut arriver plusieurs fois.
  const existing = await prisma.webhookEvent.findUnique({
    where: { source_externalId: { source: "whop", externalId: envelope.id } },
  });
  if (existing?.processedAt) {
    return NextResponse.json({ ok: true, deduplicated: true });
  }

  const record = await prisma.webhookEvent.upsert({
    where: { source_externalId: { source: "whop", externalId: envelope.id } },
    create: {
      source: "whop",
      externalId: envelope.id,
      eventType: envelope.type,
      payload: envelope as never,
    },
    update: { eventType: envelope.type, payload: envelope as never },
  });

  try {
    if (isMembershipEvent(envelope.type)) {
      const dto = normalizeMembership(envelope.data as Record<string, unknown>);
      await upsertMembership(dto);
    } else {
      await logEvent({
        stage: "whop",
        entity: `webhook:${envelope.id}`,
        message: `Événement ${envelope.type} reçu, aucune action associée`,
      });
    }

    await prisma.webhookEvent.update({ where: { id: record.id }, data: { processedAt: new Date(), error: null } });
    return NextResponse.json({ ok: true, type: envelope.type });
  } catch (err) {
    await prisma.webhookEvent.update({ where: { id: record.id }, data: { error: (err as Error).message } });
    await logEvent({
      stage: "whop",
      entity: `webhook:${envelope.id}`,
      level: "error",
      message: `Traitement du webhook échoué : ${(err as Error).message}`,
    });
    // 500 : Whop rejouera la livraison.
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
