'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transmitMessage } = require('../send-message');
const route = '/channels/@me/123';
const text = '새 메시지';
const base = () => ({ route,canSend:true,hasDialog:false,draftText:'',rows:[{id:'old',text:'이전 내용'}] });
function harness({ before=base(), after=[], inserted={ok:true,focused:true,text,route}, ready={ok:true,route}, empty={ok:true,focused:true,text:'',route}, onInsert=()=>{} }={}) {
  let reads=0,states=0;
  const inserts=[],events=[];
  return {
    inserts,events,
    run: (overrides={}) => transmitMessage({request:{route,text},wc:{insertText:async value=>{inserts.push(value);await onInsert();},sendInputEvent:event=>events.push(event)},
      readSnapshot:async()=>{const index=reads++;return index===0?before:after[Math.min(index-1,after.length-1)]||before;},
      callAdapter:async method=>method==='focusComposer'?ready:states++===0?empty:inserted,
      focus:()=>{},wait:async()=>{},...overrides})
  };
}
test('native Enter is sent once and success waits for a new nonpending message',async()=>{
  const h=harness({after:[{...base(),rows:[...base().rows,{id:'new',text,own:true,pending:true}]},{...base(),rows:[...base().rows,{id:'new',text,own:true,pending:false}]}]});
  assert.equal((await h.run()).ok,true);
  assert.deepEqual(h.inserts,[text]);
  assert.deepEqual(h.events.map(event=>event.type),['keyDown','char','keyUp']);
});
test('mismatched recipient and a native draft cannot initiate insertion',async()=>{
  const wrong=harness({before:{...base(),route:'/channels/@me/456'}});
  assert.equal((await wrong.run()).ok,false);assert.equal(wrong.inserts.length,0);assert.equal(wrong.events.length,0);
  const existing=harness({ready:{ok:false,error:'native draft'}});
  assert.equal((await existing.run()).ok,false);assert.equal(existing.inserts.length,0);
});
test('route or focus change after inserting text prevents Enter and reports uncertainty',async()=>{
  for(const inserted of [{ok:false,focused:true,text},{ok:true,focused:false,text}]) {
    const h=harness({inserted});const result=await h.run();
    assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(h.inserts.length,1);assert.equal(h.events.length,0);
  }
});
test('an existing identical message cannot acknowledge a send and no retry is emitted',async()=>{
  const before={...base(),rows:[{id:'old',text}]};
  const h=harness({before,after:[before]});const result=await h.run();
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(h.inserts.length,1);assert.equal(h.events.length,3);
});
test('a Discord failed-message state is not reported as sent',async()=>{
  const h=harness({after:[{...base(),rows:[{id:'new',text,own:true,failed:true}]}]});
  const result=await h.run();assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(h.events.length,3);
});

test('a new matching message from another person cannot acknowledge our send', async()=>{
  const h=harness({after:[{...base(),rows:[{id:'incoming',text,own:false,pending:false}]}]});
  const result=await h.run();
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.equal(h.inserts.length,1);assert.equal(h.events.length,3);
});

test('insertion preserves the exact supplied whitespace and Unicode text', async()=>{
  const raw='  새 메시지\n';
  const h=harness({inserted:{ok:true,focused:true,text:raw,route},after:[{...base(),rows:[{id:'new',text:raw,own:true}]}]});
  assert.equal((await h.run({request:{route,text:raw}})).ok,true);
  assert.deepEqual(h.inserts,[raw]);
});

test('lifecycle cancellation before insertion cannot type and cancellation during insertion cannot press Enter', async()=>{
  const before=harness();
  assert.equal((await before.run({isCurrent:()=>false})).ok,false);
  assert.equal(before.inserts.length,0);assert.equal(before.events.length,0);
  let active=true;
  const during=harness({onInsert:()=>{active=false;}});
  const result=await during.run({isCurrent:()=>active});
  assert.equal(result.uncertain,true);assert.equal(during.inserts.length,1);assert.equal(during.events.length,0);
});

test('deadline expiry after insertion leaves the native draft and never presses Enter', async()=>{
  let clock=0;
  const h=harness();
  const result=await h.run({now:()=>clock,timeoutMs:50,wait:async ms=>{clock+=ms;}});
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.equal(h.inserts.length,1);assert.equal(h.events.length,0);
});

test('read and insertion failures report whether text could have reached Discord', async()=>{
  const before=harness();
  const unreadable=await before.run({readSnapshot:async()=>{throw new Error('guest gone');}});
  assert.equal(unreadable.ok,false);assert.notEqual(unreadable.uncertain,true);
  assert.equal(before.inserts.length,0);
  const during=harness({onInsert:()=>{throw new Error('insert outcome unknown');}});
  const uncertain=await during.run();
  assert.equal(uncertain.ok,false);assert.equal(uncertain.uncertain,true);assert.equal(during.events.length,0);
});

test('unvalidated requests and a preexisting native draft cannot initiate mutation', async()=>{
  for(const request of [null,{route,text:''},{route:'/channels/@me',text},{route,text:'x'.repeat(2001)}]) {
    const h=harness();assert.equal((await h.run({request})).ok,false);assert.equal(h.inserts.length,0);
  }
  const h=harness({before:{...base(),draftText:'native draft'}});
  assert.equal((await h.run()).ok,false);assert.equal(h.inserts.length,0);assert.equal(h.events.length,0);
});

test('missing or mismatched composer route evidence cannot initiate insertion', async()=>{
  for(const empty of [{ok:true,focused:true,text:''},{ok:true,focused:true,text:'',route:'/channels/@me/456'}]) {
    const h=harness({empty});assert.equal((await h.run()).ok,false);assert.equal(h.inserts.length,0);
  }
});

test('newly visible old own history cannot acknowledge a pending send that later fails', async()=>{
  const clock = Date.now();
  const older = {id:'older-outside-initial-view',text,own:true,time:new Date(clock-3600000).toISOString()};
  const pending = {id:'actual-pending',text,own:true,pending:true,time:new Date(clock).toISOString()};
  const h = harness({after:[
    {...base(),rows:[older,pending]},
    {...base(),rows:[older,{...pending,pending:false,failed:true}]}
  ]});
  const result = await h.run({now:()=>clock});
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.match(result.error,/전송 실패/);
  assert.equal(h.inserts.length,1);assert.equal(h.events.length,3);
});

test('old confirmed own messages are excluded by rendered time or native snowflake time', async()=>{
  const clock = Date.now();
  const oldSnowflake = ((BigInt(clock-3600000)-1420070400000n)<<22n).toString();
  for(const old of [
    {id:'older-only',time:new Date(clock-3600000).toISOString()},
    {id:'chat-messages-123-'+oldSnowflake}
  ]) {
    const h = harness({after:[{...base(),rows:[{...old,text,own:true}]}]});
    const result = await h.run({now:()=>clock});
    assert.equal(result.ok,false);assert.equal(result.uncertain,true);
    assert.equal(h.events.length,3);
  }
});

test('a pending row replaced by a fresh server ID can acknowledge with timestamp precision tolerance', async()=>{
  const clock = Date.now();
  const pending = {id:'local-pending',text,own:true,pending:true};
  const finalSnowflake = ((BigInt(clock-1000)-1420070400000n)<<22n).toString();
  for(const final of [
    {id:'confirmed-server-id',time:new Date(clock-1000).toISOString()},
    {id:'chat-messages-123-'+finalSnowflake}
  ]) {
    const h = harness({after:[
      {...base(),rows:[pending]},
      {...base(),rows:[{...final,text,own:true}]}
    ]});
    assert.equal((await h.run({now:()=>clock})).ok,true);
    assert.equal(h.events.length,3);
  }
});

test('undated confirmed history beside a pending row cannot become its receipt later', async()=>{
  const historical = {id:'untimed-history',text,own:true};
  const pending = {id:'pending-identity',text,own:true,pending:true};
  const h = harness({after:[
    {...base(),rows:[historical,pending]},
    {...base(),rows:[historical]}
  ]});
  const result = await h.run();
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.equal(h.events.length,3);
});

test('multiple matching pending or confirmed rows are ambiguous and cannot claim success', async()=>{
  for(const pending of [true,false]) {
    const h = harness({after:[{...base(),rows:[
      {id:'first-match',text,own:true,pending},
      {id:'second-match',text,own:true,pending}
    ]}]});
    const result = await h.run();
    assert.equal(result.ok,false);assert.equal(result.uncertain,true);
    assert.equal(h.events.length,3);
  }
});

test('a different undated ID cannot replace an observed pending identity', async()=>{
  const h = harness({after:[
    {...base(),rows:[{id:'observed-pending',text,own:true,pending:true}]},
    {...base(),rows:[{id:'unproven-replacement',text,own:true}]}
  ]});
  const result = await h.run();
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.equal(h.events.length,3);
});
