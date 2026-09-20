/** Two real independent WebSockets per mode, solving from feedback, LOCAL ONLY. */
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {loadPool,evaluate} from './loadtest-shared.mjs';
const base=process.argv[2]??'http://127.0.0.1:8798';
if(!['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname))throw new Error('Local target required');
const pool=loadPool(); const sockets=[];
async function run(mode) {
 const rounds=mode==='misto'?4:1;
 const res=await fetch(`${base}/api/rooms`,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({mode,rounds,pace:.5})});assert.equal(res.status,201);const{code,hostToken}=await res.json();
 let resolveEnd,rejectEnd;const done=new Promise((res,rej)=>{resolveEnd=res;rejectEnd=rej;});
 let welcomed=0,ended=0;const shapes=[];let host;
 for(let i=0;i<2;i++){
  const ws=new WebSocket(`${base.replace(/^http/,'ws')}/api/rooms/${code}/ws`,{origin:base});sockets.push(ws);if(i===0)host=ws;
  let candidates=[],solved=[],seq=0,max=0,used=0,stopped=false;
  function guess(){if(stopped || used>=max || solved.every(Boolean))return;const board=solved.findIndex(x=>!x);const word=candidates[board][0];if(!word){rejectEnd(new Error('empty candidates'));return;} ws.send(JSON.stringify({t:'guess',word,seq:++seq}));}
  ws.on('open',()=>ws.send(JSON.stringify({t:'join',v:2,name:`QA${i}`,token:i===0?hostToken:undefined})));
  ws.on('error',rejectEnd);
  ws.on('message',raw=>{try{const m=JSON.parse(raw);
   if(m.t==='welcome'){if(++welcomed===2)host.send(JSON.stringify({t:'start'}));}
   if(m.t==='roundStart'){if(i===0)console.log('ROUND',mode,m.room.round,m.boards);candidates=Array.from({length:m.boards},()=>[...pool]);solved=new Array(m.boards).fill(false);used=0;max=m.maxGuesses;if(i===0)shapes.push(m.boards);guess();}
   if(m.t==='result'){assert.equal(m.ok,true);used=m.guessesUsed;solved=m.solved;for(let b=0;b<candidates.length;b++)candidates[b]=candidates[b].filter(w=>JSON.stringify(evaluate(m.word,w))===JSON.stringify(m.tiles[b])); if(!m.finished)setTimeout(guess,230);}
   if(m.t==='matchEnd'){stopped=true;assert.ok(Number.isFinite(m.you.score)); if(m.you.breakdown){const b=m.you.breakdown;assert.equal(b.total,b.words+b.attempts+b.speed+b.perfect+b.streak);}if(++ended===2){console.log('COMPLETE',mode);assert.deepEqual(shapes,mode==='misto'?[1,2,3,4]:[{termo:1,dueto:2,trieto:3,quarteto:4}[mode]]);resolveEnd({mode,rounds,players:2,shapes});}}
   if(m.t==='error')rejectEnd(new Error(m.code));
  }catch(e){rejectEnd(e);}});
 }
 const timeout=setTimeout(()=>rejectEnd(new Error(`timeout ${mode}`)),110000);
 try{return await done;}finally{clearTimeout(timeout);}
}
try {for(const result of await Promise.all(['termo','dueto','trieto','quarteto','misto'].map(run)))console.log('PASS',JSON.stringify(result));}
finally{for(const ws of sockets)ws.terminate();}
