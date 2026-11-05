'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transmitMessage } = require('../send-message');
const route = '/channels/@me/123';
const text = '새 메시지';
const base = () => ({ route,canSend:true,routeReady:true,hasDialog:false,draftText:'',rows:[{id:'old',text:'이전 내용'}] });
function harness({ before=base(), after=[], inserted={ok:true,focused:true,text,route}, ready={ok:true,route}, empty={ok:true,focused:true,text:'',route}, onInsert=()=>{}, submit={ok:true,dispatched:true}, onSubmit=()=>{} }={}) {
  let reads=0,states=0;
  const inserts=[],submissions=[],nativeEvents=[];
  return {
    inserts,submissions,nativeEvents,get reads(){return reads;},
    run: (overrides={}) => {
      const {callAdapter:overrideAdapter,...options}=overrides;
      return transmitMessage({request:{route,text},wc:{insertText:async value=>{inserts.push(value);await onInsert();},sendInputEvent:event=>nativeEvents.push(event)},
      readSnapshot:async()=>{const index=reads++;return index===0?before:after[Math.min(index-1,after.length-1)]||before;},
      callAdapter:async(method,...args)=>{
        if(method==='submitComposer') {submissions.push(args);await onSubmit();return submit;}
        if(overrideAdapter) return overrideAdapter(method,...args);
        return method==='focusComposer'?ready:states++===0?empty:inserted;
      },
      focus:()=>{},wait:async()=>{},...options});
    }
  };
}
test('guarded editor submission runs once and an empty native composer releases its pending receipt',async()=>{
  const h=harness({after:[{...base(),rows:[...base().rows,{id:'new',text,own:true,pending:true}]},{...base(),rows:[...base().rows,{id:'new',text,own:true,pending:false}]}]});
  const result=await h.run();
  assert.equal(result.ok,true);assert.equal(result.pending,true);
  assert.deepEqual(result.receipt.pendingIds,['new']);
  assert.equal(h.reads,2);
  assert.deepEqual(h.inserts,[text]);
  assert.deepEqual(h.submissions,[[route,text]]);
  assert.deepEqual(h.nativeEvents,[]);
});
test('mismatched recipient and a native draft cannot initiate insertion',async()=>{
  const wrong=harness({before:{...base(),route:'/channels/@me/456'}});
  assert.equal((await wrong.run()).ok,false);assert.equal(wrong.inserts.length,0);assert.equal(wrong.submissions.length,0);
  const existing=harness({ready:{ok:false,error:'native draft'}});
  assert.equal((await existing.run()).ok,false);assert.equal(existing.inserts.length,0);
});
test('route or focus change after inserting text prevents Enter and reports uncertainty',async()=>{
  for(const inserted of [{ok:false,focused:true,text},{ok:true,focused:false,text}]) {
    const h=harness({inserted});const result=await h.run();
    assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(h.inserts.length,1);assert.equal(h.submissions.length,0);
  }
});
test('an existing identical message leaves an unconfirmed receipt and no retry is emitted',async()=>{
  const before={...base(),rows:[{id:'old',text}]};
  const h=harness({before,after:[before]});const result=await h.run();
  assert.equal(result.ok,true);assert.equal(result.pending,true);assert.equal(h.inserts.length,1);assert.equal(h.submissions.length,1);
  assert.deepEqual(result.receipt.existingIds,['old']);
});
test('a Discord failed-message state is not reported as sent',async()=>{
  const h=harness({after:[{...base(),rows:[{id:'new',text,own:true,failed:true}]}]});
  const result=await h.run();assert.equal(result.ok,false);assert.equal(result.uncertain,true);assert.equal(h.submissions.length,1);
});

test('a new matching message from another person cannot acknowledge our send', async()=>{
  const h=harness({after:[{...base(),rows:[{id:'incoming',text,own:false,pending:false}]}]});
  const result=await h.run();
  assert.equal(result.ok,true);assert.equal(result.pending,true);
  assert.equal(h.inserts.length,1);assert.equal(h.submissions.length,1);
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
  assert.equal(before.inserts.length,0);assert.equal(before.submissions.length,0);
  let active=true;
  const during=harness({onInsert:()=>{active=false;}});
  const result=await during.run({isCurrent:()=>active});
  assert.equal(result.uncertain,true);assert.equal(during.inserts.length,1);assert.equal(during.submissions.length,0);
});

test('deadline expiry after insertion leaves the native draft and never presses Enter', async()=>{
  let clock=0;
  const h=harness({inserted:{ok:true,focused:true,text:'',route}});
  const result=await h.run({now:()=>clock,timeoutMs:50,wait:async ms=>{clock+=ms;}});
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.equal(h.inserts.length,1);assert.equal(h.submissions.length,0);
});

test('an immediately rendered receipt has no forced insertion or polling delay', async()=>{
  const waits=[];
  const h=harness({after:[{...base(),rows:[{id:'new',text,own:true}]}]});
  const result=await h.run({wait:async ms=>waits.push(ms)});
  assert.equal(result.ok,true);
  assert.equal(result.pending,false);
  assert.equal(result.confirmedRowId,'new');
  assert.equal(result.receipt.text,text);
  assert.deepEqual(waits,[]);
  assert.equal(h.submissions.length,1);
});

test('an explicitly dispatched message releases immediately when the native draft clears before a row appears', async()=>{
  const waits=[];
  const h=harness({after:[base()]});
  const result=await h.run({wait:async ms=>waits.push(ms)});
  assert.equal(result.ok,true);
  assert.equal(result.pending,true);
  assert.equal(result.confirmedRowId,undefined);
  assert.equal(result.receipt.text,text);
  assert.deepEqual(result.receipt.existingIds,['old']);
  assert.deepEqual(waits,[]);
  assert.equal(h.reads,2);
  assert.equal(h.submissions.length,1);
});

test('handoff waits only until the native draft clears and retains the background receipt', async()=>{
  const waits=[];
  const h=harness({after:[{...base(),draftText:text},base()]});
  const result=await h.run({wait:async ms=>waits.push(ms)});
  assert.equal(result.ok,true);
  assert.equal(result.pending,true);
  assert.deepEqual(waits,[50]);
  assert.equal(h.reads,3);
  assert.equal(h.submissions.length,1);
});

test('a retained or unreadable native draft, missing composer, logged-out view, stale route, or dialog cannot release the send gate as accepted', async()=>{
  for(const change of [{draftText:text},{draftText:null},{draftText:undefined},{canSend:false},{canSend:undefined},{loggedIn:false},{routeReady:false},{routeReady:undefined},{hasDialog:true},{route:'/channels/@me/456'}]) {
    let clock=0;
    const h=harness({after:[{...base(),...change}]});
    const result=await h.run({now:()=>clock,timeoutMs:300,wait:async ms=>{clock+=ms;}});
    assert.equal(result.ok,false,JSON.stringify(change));
    assert.equal(result.pending,undefined);
    assert.equal(result.uncertain,true);
    assert.equal(result.submitted,true);
    assert.equal(h.submissions.length,1);
  }
});

test('a briefly incomplete insertion settles without inserting or sending twice', async()=>{
  const waits=[],order=[];
  let states=0;
  const h=harness({after:[{...base(),rows:[{id:'new',text,own:true}]}]});
  const result=await h.run({
    focus:()=>order.push('native-focus'),
    callAdapter:async method=>{
      order.push(method);
      if(method==='focusComposer') return {ok:true,route};
      return {ok:true,focused:true,route,text:['','','새',text][Math.min(states++,3)]};
    },
    wait:async ms=>waits.push(ms)
  });
  assert.equal(result.ok,true);
  assert.deepEqual(order.slice(0,2),['focusComposer','native-focus']);
  assert.deepEqual(waits,[20,20]);
  assert.deepEqual(h.inserts,[text]);
  assert.equal(h.submissions.length,1);
});

test('send-specific snapshots avoid full sidebar snapshots and poll promptly', async()=>{
  const waits=[];
  let reads=0;
  const h=harness();
  const result=await h.run({
    readSnapshot:async()=>{throw new Error('full snapshot is unnecessary');},
    readSendSnapshot:async()=>++reads===1?base():reads===2?{...base(),draftText:text}:{...base(),rows:[{id:'new',text,own:true}]},
    wait:async ms=>waits.push(ms)
  });
  assert.equal(result.ok,true);
  assert.deepEqual(waits,[50]);
  assert.equal(reads,3);
});

test('native focus settling is checked before Enter without a fixed delay on focused sends', async()=>{
  const waits=[];
  let focused=false;
  const h=harness({after:[{...base(),rows:[{id:'new',text,own:true}]}]});
  const result=await h.run({isFocused:()=>focused,wait:async ms=>{waits.push(ms);focused=true;}});
  assert.equal(result.ok,true);
  assert.deepEqual(waits,[20]);
  assert.deepEqual(h.inserts,[text]);
  assert.equal(h.submissions.length,1);
});

test('losing native window focus leaves the draft without emitting Enter or a submitted receipt', async()=>{
  const waits=[];
  const h=harness();
  const result=await h.run({isFocused:()=>false,wait:async ms=>waits.push(ms)});
  assert.equal(result.uncertain,true);
  assert.equal(result.submitted,false);
  assert.equal(result.receipt,undefined);
  assert.match(result.error,/전송하지 않았습니다/);
  assert.deepEqual(h.inserts,[text]);
  assert.equal(h.submissions.length,0);
  assert.equal(waits.reduce((sum,ms)=>sum+ms,0),120);
});

test('native focus flags cannot bypass the renderer document focus acknowledgement', async()=>{
  for(const recovers of [true,false]) {
    const waits=[];
    let documentFocused=false,states=0;
    const h=harness({after:[{...base(),rows:[{id:'new',text,own:true}]}]});
    const result=await h.run({
      isFocused:()=>true,
      callAdapter:async method=>method==='focusComposer'?{ok:true,route}:{ok:true,focused:true,documentFocused,route,text:states++===0?'':text},
      wait:async ms=>{waits.push(ms);if(recovers) documentFocused=true;}
    });
    assert.equal(result.ok,recovers);
    assert.deepEqual(h.inserts,[text]);
    assert.equal(h.submissions.length,recovers?1:0);
    assert.equal(waits.reduce((sum,ms)=>sum+ms,0),recovers?20:120);
    if(!recovers) {assert.equal(result.submitted,false);assert.equal(result.receipt,undefined);}
  }
});

test('a timed-out submitted message carries evidence for safe late confirmation', async()=>{
  const {observeReceipt}=require('../src/shared/message-receipt');
  let clock=Date.now();
  const h=harness({after:[{...base(),draftText:text,rows:[{id:'pending',text,own:true,pending:true}]}]});
  const result=await h.run({now:()=>clock,timeoutMs:300,wait:async ms=>{clock+=ms;}});
  assert.equal(result.uncertain,true);
  assert.equal(result.submitted,true);
  assert.equal(result.receipt.text,text);
  assert.deepEqual(result.receipt.existingIds,['old']);
  assert.deepEqual(result.receipt.pendingIds,['pending']);
  assert.equal(observeReceipt(result.receipt,{...base(),rows:[{id:'pending',text,own:true}]},clock).status,'confirmed');
  assert.equal(h.submissions.length,1);
});

test('text inserted without Enter cannot be mistaken for a submitted receipt', async()=>{
  const h=harness({inserted:{ok:true,focused:false,text,route}});
  const result=await h.run();
  assert.equal(result.uncertain,true);
  assert.equal(result.submitted,false);
  assert.equal(result.receipt,undefined);
  assert.equal(h.submissions.length,0);
});

test('adapter rejection before dispatch preserves the draft without a submitted receipt', async()=>{
  const h=harness({submit:{ok:false,dispatched:false,error:'editor changed before dispatch'}});
  const result=await h.run();
  assert.equal(result.ok,false);
  assert.equal(result.uncertain,true);
  assert.equal(result.submitted,false);
  assert.equal(result.receipt,undefined);
  assert.equal(result.error,'editor changed before dispatch');
  assert.deepEqual(h.submissions,[[route,text]]);
  assert.deepEqual(h.nativeEvents,[]);
});

test('partial delivery and bridge failures retain receipt evidence without any fallback or resend', async()=>{
  for(const options of [
    {submit:{ok:false,dispatched:true,error:'keyup failed after keydown'}},
    {onSubmit:()=>{throw new Error('bridge disconnected after delivery');}},
    {submit:null}
  ]) {
    const h=harness(options);
    const result=await h.run();
    assert.equal(result.ok,false);
    assert.equal(result.uncertain,true);
    assert.equal(result.submitted,true);
    assert.equal(result.receipt.text,text);
    assert.deepEqual(result.receipt.existingIds,['old']);
    assert.deepEqual(h.submissions,[[route,text]]);
    assert.deepEqual(h.nativeEvents,[]);
  }
});

test('formatted messages acknowledge their rendered text without changing submitted text', async()=>{
  const raw='**굵게** 그리고 `const x = 1;`';
  const h=harness({inserted:{ok:true,focused:true,text:raw,route},after:[{...base(),rows:[{id:'new',text:'굵게 그리고 const x = 1;',own:true}]}]});
  assert.equal((await h.run({request:{route,text:raw}})).ok,true);
  assert.deepEqual(h.inserts,[raw]);
});

test('read and insertion failures report whether text could have reached Discord', async()=>{
  const before=harness();
  const unreadable=await before.run({readSnapshot:async()=>{throw new Error('guest gone');}});
  assert.equal(unreadable.ok,false);assert.notEqual(unreadable.uncertain,true);
  assert.equal(before.inserts.length,0);
  const during=harness({onInsert:()=>{throw new Error('insert outcome unknown');}});
  const uncertain=await during.run();
  assert.equal(uncertain.ok,false);assert.equal(uncertain.uncertain,true);assert.equal(during.submissions.length,0);
});

test('unvalidated requests and a preexisting native draft cannot initiate mutation', async()=>{
  for(const request of [null,{route,text:''},{route:'/channels/@me',text},{route,text:'x'.repeat(2001)}]) {
    const h=harness();assert.equal((await h.run({request})).ok,false);assert.equal(h.inserts.length,0);
  }
  const h=harness({before:{...base(),draftText:'native draft'}});
  assert.equal((await h.run()).ok,false);assert.equal(h.inserts.length,0);assert.equal(h.submissions.length,0);
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
    {...base(),draftText:text,rows:[older,pending]},
    {...base(),rows:[older,{...pending,pending:false,failed:true}]}
  ]});
  const result = await h.run({now:()=>clock});
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.match(result.error,/전송 실패/);
  assert.equal(h.inserts.length,1);assert.equal(h.submissions.length,1);
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
    assert.equal(result.ok,true);assert.equal(result.pending,true);
    assert.equal(h.submissions.length,1);
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
      {...base(),draftText:text,rows:[pending]},
      {...base(),rows:[{...final,text,own:true}]}
    ]});
    assert.equal((await h.run({now:()=>clock})).ok,true);
    assert.equal(h.submissions.length,1);
  }
});

test('undated confirmed history beside a pending row cannot become its receipt later', async()=>{
  const historical = {id:'untimed-history',text,own:true};
  const pending = {id:'pending-identity',text,own:true,pending:true};
  const h = harness({after:[
    {...base(),draftText:text,rows:[historical,pending]},
    {...base(),draftText:text,rows:[historical]}
  ]});
  const result = await h.run();
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.equal(h.submissions.length,1);
});

test('multiple matching pending or confirmed rows are ambiguous and cannot claim success', async()=>{
  for(const pending of [true,false]) {
    const h = harness({after:[{...base(),rows:[
      {id:'first-match',text,own:true,pending},
      {id:'second-match',text,own:true,pending}
    ]}]});
    const result = await h.run();
    assert.equal(result.ok,false);assert.equal(result.uncertain,true);
    assert.equal(h.submissions.length,1);
  }
});

test('a different undated ID cannot replace an observed pending identity', async()=>{
  const h = harness({after:[
    {...base(),draftText:text,rows:[{id:'observed-pending',text,own:true,pending:true}]},
    {...base(),draftText:text,rows:[{id:'unproven-replacement',text,own:true}]}
  ]});
  const result = await h.run();
  assert.equal(result.ok,false);assert.equal(result.uncertain,true);
  assert.equal(h.submissions.length,1);
});
