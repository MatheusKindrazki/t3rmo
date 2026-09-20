import { Room } from './room.ts';
import { MODE_IDS, MODES } from '@arena/core';
import { allowedOrigin, harden, readConfig } from './security.ts';
export { Room };
interface RateLimit { limit(opts: {key:string}): Promise<{success:boolean}> }
export interface Env { ROOM: DurableObjectNamespace; ASSETS: Fetcher; CREATE_LIMIT: RateLimit; ENTRY_LIMIT: RateLimit }
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(): string {
  // Rejection sampling avoids modulo bias for a non-power-of-two alphabet.
  let code = ''; while(code.length < 4) { const b = crypto.getRandomValues(new Uint8Array(1))[0]!; if(b < Math.floor(256/ALPHABET.length)*ALPHABET.length) code += ALPHABET[b % ALPHABET.length]; } return code;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
async function route(req: Request, env: Env): Promise<Response> {
 const url = new URL(req.url); const p = url.pathname;
 if (p === '/api/health') return json({ok:true, protocol:2, modes:MODE_IDS.map(m=>MODES[m])});
 if (p.startsWith('/api/rooms')) {
   if ((req.method !== 'GET' || req.headers.get('Upgrade') === 'websocket') && !allowedOrigin(req)) return json({error:'origem não permitida'},403);
   // CF overwrites this trusted edge header. Missing IP uses a shared fallback, not an unlimited random key.
   const ip = req.headers.get('CF-Connecting-IP') ?? 'local';
   if (p === '/api/rooms' && req.method === 'POST') {
     if (!(await env.CREATE_LIMIT.limit({key:ip})).success) { const r=json({error:'muitas salas em pouco tempo — espere um minuto'},429); r.headers.set('Retry-After','60'); return r; }
     const config = await readConfig(req); if(!config) return json({error:'configuração inválida'},400);
     for(let attempt=0;attempt<5;attempt++) {
       const code=newCode(); const stub=env.ROOM.get(env.ROOM.idFromName(code));
       // Only this path can address /internal/create; no public URL/header is forwarded here.
       const res=await stub.fetch(new Request('https://room/internal/create',{method:'POST',body:JSON.stringify({code,...config})}));
       if(res.status === 409) continue;
       return res;
     }
     return json({error:'não foi possível reservar uma sala — tente novamente'},503);
   }
   const m=/^\/api\/rooms\/([A-Z0-9]{4})(\/ws|\/info)$/.exec(p);
   if(m && req.method==='GET') {
     if(!(await env.ENTRY_LIMIT.limit({key:`${ip}:${m[2]}`})).success) {const r=json({error:'muitas tentativas — espere um minuto'},429);r.headers.set('Retry-After','60');return r;}
     const target=new URL(req.url); target.pathname=m[2]!; target.search='';
     return env.ROOM.get(env.ROOM.idFromName(m[1]!)).fetch(new Request(target, req));
   }
 }
 if(p.startsWith('/api/')) return json({error:'not found'},404);
 const knownPage = ['/', '/como-jogar/', '/jogar-com-amigos/'].includes(p);
 if (p === '/como-jogar' || p === '/jogar-com-amigos') return Response.redirect(url.origin+p+'/',308);
 if (!knownPage && !p.startsWith('/assets/') && !['/favicon.svg','/og.png','/robots.txt','/sitemap.xml','/manifest.webmanifest'].includes(p)) return new Response('Página não encontrada',{status:404,headers:{'content-type':'text/plain; charset=utf-8'}});
 const asset = await env.ASSETS.fetch(req);
 if (!knownPage && asset.headers.get('content-type')?.includes('text/html')) return new Response('Not found',{status:404});
 return asset;
}
export default {
 async fetch(req: Request, env: Env): Promise<Response> {
   try {return harden(await route(req,env));} catch {return harden(json({error:'não foi possível concluir agora — tente novamente'},500));}
 }
} satisfies ExportedHandler<Env>;
