import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/room.ts';

class Storage {
  data = new Map<string, any>(); alarm: number | null = null;
  async get(key: string) { return structuredClone(this.data.get(key)); }
  async put(key: string, value: any) { this.data.set(key, structuredClone(value)); }
  async delete(key: string) { return this.data.delete(key); }
  async deleteAll() { this.data.clear(); }
  async list({ prefix = '' } = {}) { return structuredClone(new Map([...this.data].filter(([k]) => k.startsWith(prefix)))); }
  async getAlarm() { return this.alarm; }
  async setAlarm(time: number) { this.alarm = time; }
  async deleteAlarm() { this.alarm = null; }
}
class Socket {
  messages: any[] = []; attachment: any = {acceptedAt: Date.now()}; closed: number | null = null;
  send(raw: string) { this.messages.push(JSON.parse(raw)); }
  serializeAttachment(a: any) { this.attachment = structuredClone(a); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  close(code: number) { this.closed = code; }
}
async function fixture() {
 const storage = new Storage(); const sockets: Socket[] = []; let ready: Promise<any>;
 const state = {storage, getWebSockets: () => sockets.filter(s => !s.closed), blockConcurrencyWhile(fn: any) { ready = fn(); return ready; }, acceptWebSocket(s: Socket) {sockets.push(s);} };
 const room = new Room(state as any, {}); await ready!;
 return {room, storage, sockets, wake: async () => { const next = new Room(state as any,{}); await ready!; return next; }};
}

test('query flag cannot initialize an unissued room or write its metadata', async () => {
 const {room, storage} = await fixture();
 const res = await room.fetch(new Request('https://room/info?new=1&code=TEST'));
 assert.equal(res.status, 404);
 assert.equal(storage.data.size, 0);
});

test('public socket path cannot claim a room through new=1', async () => {
 const {room, storage} = await fixture();
 const res = await room.fetch(new Request('https://room/ws?new=1&code=TEST'));
 assert.equal(res.status, 404);
 assert.equal(storage.data.size, 0);
});

import worker from '../src/index.ts';
import { parseMessage, consumeBudget, tokenHash, HOST_GRACE_MS, ROOM_TTL_MS, harden } from '../src/security.ts';
async function issued(training = false) {
 const f = await fixture();
 const res = await f.room.fetch(new Request('https://room/internal/create',{method:'POST',body:JSON.stringify({code:'TEST',mode:'termo',rounds:3,pace:1,training})}));
 assert.equal(res.status,201);
 const {hostToken} = await res.json() as {hostToken:string};
 return {...f,hostToken};
}
async function join(f: Awaited<ReturnType<typeof fixture>>, token?: string, name='player', clientId?:string) {
 const socket=new Socket(); f.sockets.push(socket);
 await f.room.webSocketMessage(socket as any,JSON.stringify({t:'join',v:2,name,token,clientId}));
 return socket;
}
const last=(s:Socket,t:string)=>s.messages.filter(m=>m.t===t).at(-1);

test('only internal issuance reserves a code, applies config and refuses collisions',async()=>{
 const f=await issued();
 const info=await (await f.room.fetch(new Request('https://room/info'))).json() as any;
 assert.equal(info.rounds,3);assert.equal(info.created,true);
 assert.equal(JSON.stringify(info).includes(f.hostToken),false);
 assert.equal('seed' in info,false);assert.equal('answers' in info,false);
 const duplicate=await f.room.fetch(new Request('https://room/internal/create',{method:'POST',body:JSON.stringify({code:'TEST'})}));
 assert.equal(duplicate.status,409);
});
test('clientId is not authentication; host and reconnect require room capability',async()=>{
 const f=await issued(); const host=await join(f,f.hostToken,'host');
 const id=last(host,'welcome').you.id;
 const attacker=await join(f,undefined,'copy',id);
 assert.notEqual(last(attacker,'welcome').you.id,id);assert.equal(last(attacker,'welcome').you.isHost,false);
 await f.room.webSocketMessage(attacker as any,JSON.stringify({t:'start'}));
 assert.equal(last(attacker,'error').code,'not-host');
 const resumed=await join(f,f.hostToken,'host');
 assert.equal(last(resumed,'welcome').you.id,id);assert.equal(host.closed,4001);
});
test('tokens cannot be replayed across rooms or after revocation',async()=>{
 const f=await issued(), other=await issued();
 assert.equal((await join(other,f.hostToken)).closed,4003);
 const host=await join(f,f.hostToken); const guest=await join(f);const welcome=last(guest,'welcome');
 await f.room.webSocketMessage(host as any,JSON.stringify({t:'kick',playerId:welcome.you.id.slice(0,8),ban:true}));
 assert.equal(guest.closed,4003); assert.equal((await join(f,welcome.token)).closed,4003);
});
test('non-host cannot kick and normalized nickname never grants authority',async()=>{
 const f=await issued();const host=await join(f,f.hostToken,'host');const guest=await join(f,undefined,'\u202ehost\u200b');
 assert.equal(last(guest,'welcome').you.name,'host');assert.equal(last(guest,'welcome').you.isHost,false);
 await f.room.webSocketMessage(guest as any,JSON.stringify({t:'kick',playerId:last(host,'welcome').you.id}));
 assert.equal(last(guest,'error').code,'not-host');assert.equal(host.closed,null);
});
test('training enforces one participant and starts only the credentialed host',async()=>{
 const f=await issued(true);assert.equal((await join(f)).closed,4003);
 const host=await join(f,f.hostToken);
 const info=await (await f.room.fetch(new Request('https://room/info'))).json() as any;
 assert.equal(info.training,true);assert.equal(info.rounds,1);assert.equal(info.phase,'countdown');
 assert.equal(last(host,'welcome').you.isHost,true);
});
test('all commands have shape/size bounds and hibernating budgets cannot reset',()=>{
 for(const raw of ['null','[]','{"t":"guess","word":5,"seq":1}','{"t":"page","from":-1,"to":1}','{"t":"unknown"}','x'.repeat(2049)]) assert.equal(parseMessage(raw),null);
 assert.equal(parseMessage(new ArrayBuffer(3)),null);
 assert.equal(parseMessage(JSON.stringify({t:'guess',word:'CARRO',seq:1}))?.t,'guess');
 let b;for(let i=0;i<60;i++){const r=consumeBudget(b,100);assert.equal(r.allowed,true);b=r.budget;}
 assert.equal(consumeBudget(structuredClone(b),101).allowed,false);
 assert.equal(consumeBudget(b,10101).allowed,true);
});
test('invalid frames close only the sender, not the other player',async()=>{
 const f=await issued();const host=await join(f,f.hostToken),guest=await join(f);
 await f.room.webSocketMessage(guest as any,'{"t":"ping","ts":{}}');
 assert.equal(guest.closed,4008);assert.equal(host.closed,null);
});
test('repeated join cannot mint identities on one socket',async()=>{
 const f=await issued();const g=await join(f);const before=f.storage.data.size;
 await f.room.webSocketMessage(g as any,JSON.stringify({t:'join',v:2,name:'other'}));
 assert.equal(f.storage.data.size,before);assert.equal(g.messages.filter(m=>m.t==='welcome').length,1);
});
test('disconnected host keeps authority during grace then successor is explicit',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});
 const f=await issued();const host=await join(f,f.hostToken),guest=await join(f);
 host.closed=1000;await f.room.webSocketClose(host as any);
 await f.room.webSocketMessage(guest as any,JSON.stringify({t:'start'}));assert.equal(last(guest,'error').code,'not-host');
 t.mock.timers.tick(HOST_GRACE_MS+1);await f.room.alarm();
 await f.room.webSocketMessage(guest as any,JSON.stringify({t:'start'}));
 const info=await (await f.room.fetch(new Request('https://room/info'))).json() as any;
 assert.equal(info.phase,'countdown');assert.equal(info.hostPrefix,last(guest,'welcome').you.id.slice(0,8));
});
test('expired room clears durable capabilities and closes sockets',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});const f=await issued();const h=await join(f,f.hostToken);
 t.mock.timers.tick(ROOM_TTL_MS+1);await f.room.alarm();assert.equal(f.storage.data.size,0);assert.equal(h.closed,4003);
});
test('worker rejects wrong origin, preserves limiter and hides internal creation route',async()=>{
 let calls=0;const env={CREATE_LIMIT:{limit:async()=>({success:false})},ENTRY_LIMIT:{limit:async()=>({success:true})},ROOM:{idFromName:(s:string)=>s,get:()=>({fetch:async()=>{calls++;return new Response('bad')}})}} as any;
 const wrong=await worker.fetch(new Request('https://t3rmo.com/api/rooms',{method:'POST',headers:{Origin:'https://evil.invalid'}}),env);
 assert.equal(wrong.status,403);
 const limited=await worker.fetch(new Request('https://t3rmo.com/api/rooms',{method:'POST',headers:{Origin:'https://t3rmo.com'}}),env);
 assert.equal(limited.status,429);assert.equal(limited.headers.get('Retry-After'),'60');
 const internal=await worker.fetch(new Request('https://t3rmo.com/api/rooms/TEST/internal/create'),env);
 assert.equal(internal.status,404);assert.equal(calls,0);
});
test('worker strips query flags and retries collisions only through issuance',async()=>{
 const f=await fixture();let issuedCalls=0;let forwarded='';
 const env={CREATE_LIMIT:{limit:async()=>({success:true})},ENTRY_LIMIT:{limit:async()=>({success:true})},ROOM:{idFromName:(s:string)=>s,get:()=>({fetch:async(req:Request)=>{forwarded=req.url;if(req.url.endsWith('/internal/create') && ++issuedCalls===1)return new Response('collision',{status:409});return f.room.fetch(req);}})}} as any;
 const response=await worker.fetch(new Request('https://t3rmo.com/api/rooms',{method:'POST',headers:{Origin:'https://t3rmo.com'},body:'{}'}),env);
 assert.equal(response.status,201);assert.equal(issuedCalls,2);
 await worker.fetch(new Request('https://t3rmo.com/api/rooms/TEST/info?new=1'),env);
 assert.equal(new URL(forwarded).search,'');assert.equal(new URL(forwarded).pathname,'/info');
});
test('public response hardening preserves JSON and excludes referrer leakage',()=>{
 const res=harden(Response.json({ok:true}));assert.equal(res.headers.get('Referrer-Policy'),'no-referrer');assert.match(res.headers.get('Content-Security-Policy')!,/frame-ancestors 'none'/);assert.equal(res.headers.get('X-Content-Type-Options'),'nosniff');
});
test('capability hashes persist no raw secret',async()=>{
 const f=await issued();assert.equal(f.storage.data.has(`c:${await tokenHash(f.hostToken)}`),true);
 assert.equal(JSON.stringify([...f.storage.data]).includes(f.hostToken),false);
});


test('hibernation and page never reset aggregate transport budget',async()=>{
 const f=await issued();const host=await join(f,f.hostToken); f.room=await f.wake();
 for(let i=0;i<50;i++) await f.room.webSocketMessage(host as any,JSON.stringify({t:'ping',ts:i}));
 await f.room.webSocketMessage(host as any,JSON.stringify({t:'page',from:0,to:10}));
 for(let i=0;i<12 && !host.closed;i++) await f.room.webSocketMessage(host as any,JSON.stringify({t:'ping',ts:i}));
 assert.equal(host.closed,4008);
});
test('host that never connects has a deterministic succession grace',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});const f=await issued();const guest=await join(f);
 t.mock.timers.tick(HOST_GRACE_MS+1);await f.room.alarm();
 await f.room.webSocketMessage(guest as any,JSON.stringify({t:'start'}));
 assert.equal(last(guest,'state').room.phase,'countdown');
});
test('lobby ticks include bounded real participants',async()=>{
 const f=await issued();const h=await join(f,f.hostToken,'host');await join(f,undefined,'guest');await f.room.alarm();
 const tick=last(h,'tick');assert.deepEqual(tick.top.map((r:any)=>r[2]).sort(),['guest','host']);
});
test('finished receipt survives reload and rematch changes seed and identity',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});const f=await issued(true);const h=await join(f,f.hostToken);
 t.mock.timers.tick(5001);await f.room.alarm();t.mock.timers.tick(150001);await f.room.alarm();
 const end=last(h,'matchEnd');assert.ok(end); const oldSeed=f.storage.data.get('meta').seed;
 const reload=await join(f,f.hostToken);assert.ok(last(reload,'matchEnd'));assert.equal(last(reload,'matchEnd').room.matchId,end.room.matchId);
 await f.room.webSocketMessage(reload as any,JSON.stringify({t:'start'}));
 assert.notEqual(f.storage.data.get('meta').seed,oldSeed);
 assert.notEqual(last(reload,'state').room.matchId,end.room.matchId);
});

test('player offline across the deadline receives settled final receipt on return',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});const f=await issued(true);const host=await join(f,f.hostToken);
 t.mock.timers.tick(5001);await f.room.alarm();host.closed=1000;await f.room.webSocketClose(host as any);
 t.mock.timers.tick(150001);await f.room.alarm();const back=await join(f,f.hostToken);
 assert.ok(last(back,'matchEnd'));assert.equal(last(back,'matchEnd').you.score,last(back,'state').board.score);
});

test('close handler reciprocates the peer close for runtimes without automatic reply',async()=>{
 const f=await issued();const host=await join(f,f.hostToken);await f.room.webSocketClose(host as any);
 assert.equal(host.closed,1000);
});

test('short reconnect after deadline restores settled partial score into next round',async(t)=>{
 t.mock.timers.enable({apis:['Date'],now:1_000_000});const f=await issued();const host=await join(f,f.hostToken);
 await f.room.webSocketMessage(host as any,JSON.stringify({t:'config',mode:'dueto',rounds:2,pace:1}));
 await f.room.webSocketMessage(host as any,JSON.stringify({t:'start'}));
 t.mock.timers.tick(5001);await f.room.alarm();
 const word=f.storage.data.get('meta').answers[0];
 await f.room.webSocketMessage(host as any,JSON.stringify({t:'guess',word,seq:1}));
 t.mock.timers.tick(179000);host.closed=1000;await f.room.webSocketClose(host as any);
 t.mock.timers.tick(1001);await f.room.alarm();const back=await join(f,f.hostToken);
 const settled=last(back,'roundEnd').you.score;assert.ok(settled>0);
 assert.equal(last(back,'state').board.score,settled);
 t.mock.timers.tick(20000);await f.room.alarm();
 const again=await join(f,f.hostToken);assert.equal(last(again,'state').board.score,settled);
});
