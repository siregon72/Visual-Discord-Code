'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {renderedText,matchesText,createReceipt,observeReceipt}=require('../src/shared/message-receipt');
const route='/channels/@me/123';

test('receipt text comparison handles paired Discord formatting and preserves code and literal punctuation',()=>{
  for(const [source,rendered] of [
    ['**굵게** __밑줄__ ~~취소~~ ||비밀||','굵게 밑줄 취소 비밀'],
    ['*기울임* _italics_','기울임 italics'],
    ['***둘 다***','둘 다'],
    ['**a** *b*','a b'],
    ['`**literal**`','**literal**'],
    ['```js\nconst value = "**literal**";\n```','const value = "**literal**";'],
    ['\\*literal\\*','*literal*']
  ]) {
    assert.equal(renderedText(source),rendered,source);
    assert.equal(matchesText(rendered,source),true,source);
  }
  for(const literal of ['2 * 3 * 4','file_name_here','**unfinished','https://example.com/a_b']) assert.equal(renderedText(literal),literal);
  assert.equal(matchesText('other words','**message**'),false);
});

test('a late receipt retains pending identity and cannot reinterpret an explicit failure',()=>{
  const receipt=createReceipt({route,text:'message',startedAt:Date.now(),rows:[]});
  const snapshot={route,draftText:'',rows:[{id:'pending',text:'message',own:true,pending:true}]};
  assert.equal(observeReceipt(receipt,snapshot).status,'pending');
  assert.equal(observeReceipt(receipt,{...snapshot,rows:[{id:'different-undated',text:'message',own:true}]}).status,'waiting');
  assert.equal(observeReceipt(receipt,{...snapshot,rows:[{id:'pending',text:'message',own:true,failed:true}]}).status,'failed');
  assert.equal(observeReceipt(receipt,{...snapshot,rows:[{id:'pending',text:'message',own:true}]}).status,'failed');
});

test('a changed route, dialog, existing native draft, or stale rendered room cannot confirm a receipt',()=>{
  for(const change of [{route:'/channels/@me/456'},{hasDialog:true},{draftText:'unsent'},{routeReady:false}]) {
    const receipt=createReceipt({route,text:'message',startedAt:Date.now(),rows:[]});
    const result=observeReceipt(receipt,{route,draftText:'',rows:[{id:'new',text:'message',own:true}],...change});
    assert.notEqual(result.status,'confirmed');
  }
});

test('one rendered acknowledgement can claim only one of sequential identical submissions',()=>{
  const startedAt=Date.now(),claimedIds=new Set();
  const first=createReceipt({route,text:'same',startedAt,rows:[]});
  const second=createReceipt({route,text:'same',startedAt:startedAt+1,rows:[]});
  const firstRow={id:'first-ack',text:'same',own:true,time:new Date(startedAt).toISOString()};
  const snapshot={route,routeReady:true,draftText:'',rows:[firstRow]};
  assert.equal(observeReceipt(first,snapshot,startedAt+10,{claimedIds}).status,'confirmed');
  assert.deepEqual([...claimedIds],['first-ack']);
  assert.equal(observeReceipt(second,snapshot,startedAt+10,{claimedIds}).status,'waiting');
  const secondRow={id:'second-ack',text:'same',own:true,time:new Date(startedAt+1).toISOString()};
  const observed=observeReceipt(second,{...snapshot,rows:[firstRow,secondRow]},startedAt+20,{claimedIds});
  assert.equal(observed.status,'confirmed');
  assert.equal(observed.row.id,'second-ack');
  assert.deepEqual([...claimedIds],['first-ack','second-ack']);
});

test('simultaneous indistinguishable acknowledgements stay ambiguous and claim neither row',()=>{
  const startedAt=Date.now(),claimedIds=new Set();
  const receipt=createReceipt({route,text:'same',startedAt,rows:[]});
  const snapshot={route,routeReady:true,draftText:'',rows:[
    {id:'first-ack',text:'same',own:true},
    {id:'second-ack',text:'same',own:true}
  ]};
  assert.equal(observeReceipt(receipt,snapshot,startedAt,{claimedIds}).status,'ambiguous');
  assert.equal(claimedIds.size,0);
});

test('pending, failed, stale, and draft-blocked observations never claim an acknowledgement',()=>{
  const startedAt=Date.now(),claimedIds=new Set();
  const row={id:'new',text:'message',own:true};
  for(const [change,status] of [
    [{rows:[{...row,pending:true}]},'pending'],
    [{rows:[{...row,failed:true}]},'failed'],
    [{routeReady:false},'waiting'],
    [{draftText:'next message'},'waiting']
  ]) {
    const receipt=createReceipt({route,text:'message',startedAt,rows:[]});
    const observed=observeReceipt(receipt,{route,routeReady:true,draftText:'',rows:[row],...change},startedAt,{claimedIds});
    assert.equal(observed.status,status);
    if(status==='failed') assert.equal(observed.row.id,'new');
    assert.equal(claimedIds.size,0);
  }
});
