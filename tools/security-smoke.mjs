/** Bounded runtime proof against LOCAL workerd only. No production fallback. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
const base=process.argv[2] ?? 'http://127.0.0.1:8798';
const u=new URL(base);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('Local target required');
async function connect(code,token,name='test') {
 const ws=new WebSocket(`${base.replace(/^http/,'ws')}/api/rooms/${code}/ws`,{origin:base});
 const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 ws.send(JSON.stringify({t:'join',v:2,token,name}));
 return {ws,messages};
}
async function wait(client,type,predicate=()=>true) {
 const end=Date.now()+8000;
 while(Date.now()<end){const m=client.messages.find(m=>m.t===type&&predicate(m));if(m)return m;await new Promise(r=>setTimeout(r,20));}
 throw new Error(`Timeout waiting ${type}; saw ${client.messages.map(m=>m.t+':'+(m.code??'')).join(',')}`);
}
const sockets=[];
try {
 assert.equal((await fetch(`${base}/api/rooms/ZZZZ/info?new=1`)).status,404);
 assert.equal((await fetch(`${base}/api/rooms`,{method:'POST',headers:{Origin:'https://evil.invalid'}})).status,403);
 const res=await fetch(`${base}/api/rooms`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({mode:'termo',rounds:1,pace:.5})});
 assert.equal(res.status,201);const {code,hostToken}=await res.json();
 const host=await connect(code,hostToken,'host');sockets.push(host.ws);await wait(host,'welcome');
 const guest=await connect(code,undefined,'guest');sockets.push(guest.ws);const gw=await wait(guest,'welcome');
 assert.equal(gw.you.isHost,false);assert.notEqual(gw.token,hostToken);
 guest.ws.send(JSON.stringify({t:'start'}));await wait(guest,'error',m=>m.code==='not-host');
 host.ws.send(JSON.stringify({t:'start'}));await wait(host,'roundStart');
 host.ws.send(JSON.stringify({t:'guess',word:'CARRO',seq:1}));const result=await wait(host,'result');assert.equal(result.ok,true);
 host.ws.close();await new Promise(r=>setTimeout(r,100));
 const resumed=await connect(code,hostToken,'host');sockets.push(resumed.ws);await wait(resumed,'welcome');
 const state=await wait(resumed,'state',m=>m.board?.guesses?.length);assert.deepEqual(state.board.guesses,['CARRO']);
 resumed.ws.send(JSON.stringify({t:'kick',playerId:gw.you.id,ban:true}));await wait(guest,'error',m=>m.code==='removed');
 const revoked=await connect(code,gw.token);sockets.push(revoked.ws);await wait(revoked,'error',m=>m.code==='invalid-session');
 assert.equal((await fetch(`${base}/unknown-page`)).status,404);
 console.log('PASS local workerd: issuance, origin, two identities, host permissions, guess, reconnect board recovery, kick/revocation, real 404');
} finally {for(const ws of sockets)ws.terminate();}
