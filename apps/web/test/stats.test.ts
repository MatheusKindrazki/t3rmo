import test from 'node:test';
import assert from 'node:assert/strict';
import {claimReceipt,recordTraining,loadTrainingStats,loadStats,recordRound,recordMatch} from '../src/lib/stats.ts';
const store=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{value:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v)},configurable:true});
test('same result is counted once, rematch has its own receipt, training is separate',()=>{
 const deliver=(id:string)=>{if(claimReceipt(id))recordTraining(true,3);};
 deliver('room:1:match');deliver('room:1:match');assert.equal(loadTrainingStats().sessions,1);
 deliver('room:2:match');assert.equal(loadTrainingStats().sessions,2);assert.deepEqual(loadStats(),{});
});
test('persisted receipt prevents a reload replay from adding competitive stats',()=>{
 store.set('arena.receipts.v1',JSON.stringify(['from-previous-page']));
 assert.equal(claimReceipt('from-previous-page'),false);
 if(claimReceipt('fresh-round'))recordRound('termo',{boards:1,solvedWords:1,guesses:3,rank:2});
 if(claimReceipt('fresh-match'))recordMatch('termo',2);
 assert.equal(loadStats().termo?.rounds,1);assert.equal(loadStats().termo?.matches,1);
});
