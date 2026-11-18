/**
 * Utilitaires des routes API locales, consommées par le serveur MCP.
 */
import { NextResponse } from "next/server";
import { config } from "./config";

/** `JSON.stringify` ne sait pas sérialiser un BigInt (tailles de fichiers). */
function replacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? Number(value) : value;
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return new NextResponse(JSON.stringify(data, replacer), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
  });
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>): NextResponse {
  return json({ ok: false, error: message, ...extra }, { status });
}

/**
 * Les écritures exigent le jeton partagé, s'il est configuré.
 * Sans jeton configuré, l'API reste ouverte : c'est le cas d'usage local,
 * où seul le poste de travail l'atteint.
 */
export function authorize(req: Request): NextResponse | null {
  if (!config.apiToken) return null;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : req.headers.get("x-clipflow-token");
  if (bearer !== config.apiToken) {
    return fail("Jeton invalide ou absent (en-tête Authorization: Bearer …).", 401);
  }
  return null;
}
