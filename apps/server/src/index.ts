import { Room } from './room.ts';
import { MODE_IDS, MODES } from '@arena/core';

export { Room };

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Per-IP limiter for room creation; declared in wrangler.jsonc. */
  CREATE_LIMIT: RateLimit;
}

/** Room codes a person can read out loud: no O/0, no I/1, no confusable pairs. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function normalizeCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (c.length < 3 || c.length > 8) return null;
  return c;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/api/health') {
      return json({ ok: true, modes: MODE_IDS.map((m) => MODES[m]) });
    }


    // Create: the code is minted here, the Durable Object is addressed by it.
    if (p === '/api/rooms' && req.method === 'POST') {
      // Per-IP rate limit. Creation is unauthenticated and each call can
      // materialise a Durable Object, so without this one script runs up the
      // bill unbounded. CF-Connecting-IP is set by the edge; the ?? keeps a
      // stray request without it from sharing an empty-string bucket with
      // everyone else — it just gets its own.
      const ip = req.headers.get('CF-Connecting-IP') ?? crypto.randomUUID();
      const { success } = await env.CREATE_LIMIT.limit({ key: ip });
      if (!success) {
        return json({ error: 'muitas salas em pouco tempo — espere um minuto' }, 429);
      }
      const code = newCode();
      return json({ code, ws: `/api/rooms/${code}/ws` }, 201);
    }

    const m = /^\/api\/rooms\/([^/]+)(\/ws|\/info)?$/.exec(p);
    if (m) {
      const code = normalizeCode(decodeURIComponent(m[1]!));
      if (!code) return json({ error: 'código de sala inválido' }, 400);

      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      const target = new URL(req.url);
      target.pathname = m[2] === '/info' ? '/info' : '/ws';
      target.searchParams.set('code', code);
      return stub.fetch(new Request(target, req));
    }

    if (p.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
