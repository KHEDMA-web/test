/**
 * Traitement périodique de la file de publication.
 * À appeler par un cron (Vercel Cron, GitHub Actions, systemd timer…).
 * Protégé par un secret partagé si CRON_SECRET est défini.
 */
import { NextResponse } from "next/server";
import { processQueue } from "@/lib/metricool/publish";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });
  const result = await processQueue(50);
  return NextResponse.json({ ok: true, ...result });
}

export const POST = GET;
