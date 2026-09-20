import { isMode, PACE_MIN, PACE_MAX, type ClientMessage, type Mode } from '@arena/core';

export const MAX_MESSAGE_BYTES = 2048;
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const HOST_GRACE_MS = 30_000;
export const PER_IP_SOCKETS = 64;
export const ROOM_IDENTITIES_MAX = 6000;
export interface RoomConfig { mode: Mode; rounds: number; pace: number; training: boolean }
export interface Capability { id: string; expires: number; blocked?: boolean }
export interface Budget { start: number; count: number }

export function roomConfig(value: unknown): RoomConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const mode = o.mode ?? 'termo'; const rounds = o.rounds ?? 3; const pace = o.pace ?? 1;
  if (!isMode(mode as string) || !Number.isInteger(rounds) || (rounds as number) < 1 || (rounds as number) > 12 ||
      typeof pace !== 'number' || !Number.isFinite(pace) || pace < PACE_MIN || pace > PACE_MAX ||
      (o.training !== undefined && typeof o.training !== 'boolean')) return null;
  return o.training ? {mode:'termo', rounds:1, pace:1, training:true} : {mode: mode as Mode, rounds:rounds as number, pace, training:false};
}
export function parseMessage(raw: string | ArrayBuffer): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES) return null;
  let m: Record<string, unknown>;
  try { const v: unknown = JSON.parse(raw); if (!v || typeof v !== 'object' || Array.isArray(v)) return null; m = v as Record<string, unknown>; } catch { return null; }
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  switch (m.t) {
    case 'join': if (typeof m.name !== 'string' || m.name.length > 64 || !Number.isInteger(m.v) ||
      (m.token !== undefined && (typeof m.token !== 'string' || !/^[a-f0-9]{64}$/.test(m.token)))) return null; break;
    case 'guess': if (typeof m.word !== 'string' || m.word.length > 32 || !Number.isSafeInteger(m.seq) || (m.seq as number) < 1) return null; break;
    case 'config': if ((m.mode !== undefined && !isMode(m.mode as string)) ||
      (m.rounds !== undefined && (!Number.isInteger(m.rounds) || (m.rounds as number) < 1 || (m.rounds as number) > 12)) ||
      (m.pace !== undefined && (!finite(m.pace) || (m.pace as number) < PACE_MIN || (m.pace as number) > PACE_MAX))) return null; break;
    case 'start': break;
    case 'kick': if (typeof m.playerId !== 'string' || !/^[a-f0-9-]{8,40}$/.test(m.playerId) || (m.ban !== undefined && typeof m.ban !== 'boolean')) return null; break;
    case 'page': if (!Number.isInteger(m.from) || !Number.isInteger(m.to) || (m.from as number) < 0 || (m.to as number) < (m.from as number)) return null; break;
    case 'ping': if (!finite(m.ts)) return null; break;
    default: return null;
  }
  return m as unknown as ClientMessage;
}
/** Budget lives on the hibernating socket attachment, not an isolate-only map. */
export function consumeBudget(previous: Budget | undefined, now: number): {allowed: boolean; budget: Budget} {
  const budget = previous && now - previous.start < 10_000 ? { ...previous, count: previous.count + 1 } : {start:now, count:1};
  return {allowed: budget.count <= 60, budget};
}
export function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2,'0')).join('');
}
export async function tokenHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,'0')).join('');
}
export function allowedOrigin(req: Request): boolean {
  const origin = req.headers.get('Origin');
  if (!origin) return false; // automated clients explicitly send their target origin
  const url = new URL(req.url);
  return origin === url.origin;
}
export function harden(response: Response): Response {
  if (response.status === 101) return response;
  const res = new Response(response.body, response);
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.headers.set('Strict-Transport-Security', 'max-age=31536000');
  res.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  return res;
}
/** Streaming bound also rejects chunked requests that omit Content-Length. */
export async function readConfig(req: Request): Promise<RoomConfig | null> {
  if (!req.body) return roomConfig({});
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength;
    if (size > MAX_MESSAGE_BYTES) { await reader.cancel(); return null; } chunks.push(value); }
  if (!size) return roomConfig({});
  const bytes = new Uint8Array(size); let at = 0; for (const c of chunks) {bytes.set(c,at); at += c.length;}
  try { return roomConfig(JSON.parse(new TextDecoder().decode(bytes))); } catch { return null; }
}
