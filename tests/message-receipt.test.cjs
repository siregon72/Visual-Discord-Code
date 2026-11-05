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
