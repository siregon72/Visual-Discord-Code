'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const sourcePath = path.join(__dirname, '..', 'discord-adapter.js');
const route = '/channels/100/200';
const fixture = `<!doctype html><html><body>
<nav aria-label="Servers sidebar" class="guilds_123"><div role="treeitem" data-list-item-id="guildsnav___100" aria-label="개발 모임"><span>개발 모임</span></div></nav>
<aside class="sidebar_123"><header><h1>개발 모임</h1></header><nav aria-label="Channels"><ul data-list-id="channels">
<li><a data-list-item-id="channels___200" href="/channels/100/200"><span class="name_abc">일반</span></a></li>
<li><a data-list-item-id="channels___201" href="/channels/100/201"><span class="name_abc">개발</span></a></li>
</ul></nav><nav aria-label="Private channels" class="privateChannels_123"><a data-list-item-id="private-channels-uid_1___300" href="/channels/@me/300"><span class="name_abc">민수</span></a></nav></aside>
<section class="panels_123"><img src="https://cdn.discordapp.com/avatars/999/avatar.png"><div class="nameTag_123"><span class="username_123">나</span></div></section>
<main class="chat_123"><header><h1>일반</h1></header><div class="messagesWrapper_123"><div class="scroller_123" style="overflow-y:scroll"><ol data-list-id="chat-messages">
<li id="chat-messages-200-1001" data-list-item-id="chat-messages___1001"><div class="message_123"><h3><span id="message-username-1001" class="username_123">민수</span><time datetime="2026-11-03T12:00:00Z">오후 9:00</time></h3><div id="message-content-1001" class="markup_123">안녕 &lt;script&gt;alert(1)&lt;/script&gt;</div></div></li>
<li id="chat-messages-200-1002" data-list-item-id="chat-messages___1002"><div class="message_123"><div id="message-content-1002" class="markup_123">연속 메시지</div><div class="imageWrapper_123"><a href="https://cdn.discordapp.com/attachments/200/1002/photo.png?ex=123"><img src="https://media.discordapp.net/attachments/200/1002/photo.png?width=600" alt="photo.png"></a></div></div></li>
<li id="chat-messages-200-1003" data-list-item-id="chat-messages___1003"><div class="message_123"><h3><span id="message-username-1003" class="username_123">나</span><time datetime="2026-11-03T12:01:00Z">오후 9:01</time></h3><div id="message-content-1003" class="markup_123">내 메시지 <a href="/channels/100/777">채널 링크</a></div></div></li>
</ol></div></div><form><div class="channelTextArea_123"><div role="textbox" contenteditable="true" data-slate-editor="true" class="slateTextArea_123"><p></p></div></div></form></main>
</body></html>`;

function makePage(url = 'https://discord.com' + route, html = fixture) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    configurable: true, get() { return this.textContent; }, set(value) { this.textContent = value; }
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function() {
    return { x:0, y:0, left:0, top:0, right:800, bottom:40, width:800, height:40, toJSON() {} };
  };
  dom.window.HTMLElement.prototype.getClientRects = function() { return [this.getBoundingClientRect()]; };
  dom.window.fetch = () => { throw new Error('The adapter must not use a network API'); };
  dom.window.eval(fs.readFileSync(sourcePath, 'utf8'));
  return dom;
}

test('snapshot reads rendered chats and messages without changing their text or drafts', () => {
  const dom = makePage();
  try {
    const original = dom.window.document.body.innerHTML;
    const snap = dom.window.__vdcAdapter.snapshot();
    assert.equal(snap.loggedIn, true);
    assert.equal(snap.route, route);
    assert.equal(snap.canSend, true);
    assert.equal(snap.rows.length, 3);
    assert.ok(snap.rows.some(row => row.text.includes('<script>alert(1)</script>')));
    assert.equal(snap.rows[0].author, '민수');
    assert.equal(snap.rows[1].author, '민수', 'grouped messages inherit the preceding visible author');
    assert.equal(snap.rows[1].media.length, 1, 'CDN link and resized thumbnail describe one attachment');
    assert.ok(snap.channels.some(channel => channel.route === '/channels/@me/300'));
    assert.equal(snap.channels.some(channel => channel.route === '/channels/100/777'), false, 'message links are not Explorer conversations');
    assert.equal(dom.window.document.body.innerHTML, original);
  } finally { dom.window.close(); }
});

test('hidden ancestor panels and ambiguous visible editors cannot receive a send', () => {
  const dom=makePage();
  try {
    const {document}=dom.window;
    const api=dom.window.__vdcAdapter;
    const form=document.querySelector('form');
    form.style.display='none';
    assert.equal(api.snapshot().canSend,false);
    assert.equal(api.focusComposer(route).ok,false);
    const visible=form.cloneNode(true);visible.style.display='block';document.querySelector('main').append(visible);
    assert.equal(api.snapshot().canSend,true);
    assert.equal(api.focusComposer(route).ok,true);
    assert.equal(document.activeElement,visible.querySelector('[data-slate-editor]'));
    form.style.display='block';
    assert.equal(api.snapshot().canSend,false,'two eligible editors are not guessed between');
    assert.equal(api.focusComposer(route).ok,false);
  } finally {dom.window.close();}
});

test('mixed old and new room rows block sends until the transition completes', () => {
  const dom=makePage();
  try {
    const api=dom.window.__vdcAdapter;
    dom.window.history.pushState({},'','/channels/100/201');
    dom.window.document.querySelector('[data-list-id="chat-messages"]').insertAdjacentHTML('beforeend','<li id="chat-messages-201-2001"><h3><span id="message-username-2001">새 친구</span></h3><div id="message-content-2001">새 대화</div></li>');
    const mixed=api.snapshot();
    assert.equal(mixed.routeReady,false);assert.equal(mixed.canSend,false);assert.equal(mixed.rows.length,0);
    assert.equal(api.composerState('/channels/100/201').ok,false);
    dom.window.document.querySelectorAll('li[id^="chat-messages-200-"]').forEach(row=>row.remove());
    assert.equal(api.snapshot().canSend,true);
  } finally {dom.window.close();}
});

test('quoted replies do not replace the current message text, sender or timestamp', () => {
  const dom=makePage();
  try {
    const {document}=dom.window;
    document.querySelector('#chat-messages-200-1001').insertAdjacentHTML('afterbegin','<div class="repliedMessage_123"><h3><span id="message-username-900">나</span><time datetime="2020-01-01T00:00:00Z">이전</time></h3><img class="avatar_123" src="https://cdn.discordapp.com/avatars/999/avatar.png"><div id="message-content-900">인용 내용</div></div>');
    const row=dom.window.__vdcAdapter.snapshot().rows[0];
    assert.equal(row.author,'민수');assert.equal(row.own,false);
    assert.equal(row.time,'2026-11-03T12:00:00Z');
    assert.ok(row.text.startsWith('안녕'));assert.equal(row.text.includes('인용 내용'),false);
  } finally {dom.window.close();}
});

test('duplicate and hidden message nodes are not exposed as additional messages', () => {
  const dom=makePage();
  try {
    const {document}=dom.window;
    const list=document.querySelector('[data-list-id="chat-messages"]');
    list.append(list.firstElementChild.cloneNode(true));
    const hidden=document.createElement('div');hidden.style.display='none';
    hidden.innerHTML='<li id="chat-messages-999-9000"><div id="message-content-9000">오래된 숨은 대화</div></li>';
    document.body.append(hidden);
    const snapshot=dom.window.__vdcAdapter.snapshot();
    assert.equal(snapshot.canSend,true);assert.equal(snapshot.rows.length,3);
  } finally {dom.window.close();}
});

test('focus side effects are rechecked before the composer is reported ready', () => {
  const dom=makePage();
  try {
    const composer=dom.window.document.querySelector('[data-slate-editor]');
    composer.addEventListener('focus',()=>dom.window.history.pushState({},'','/channels/100/201'));
    assert.equal(dom.window.__vdcAdapter.focusComposer(route).ok,false);
    assert.equal(dom.window.__vdcAdapter.scroll(0,route).ok,false);
  } finally {dom.window.close();}
});

test('focus guard prevents sending to a different route or overwriting a native draft', () => {
  const dom = makePage();
  try {
    const api = dom.window.__vdcAdapter;
    const composer = dom.window.document.querySelector('[data-slate-editor]');
    assert.equal(api.focusComposer('/channels/100/201').ok, false);
    assert.notEqual(dom.window.document.activeElement, composer);
    composer.innerHTML = '<p>원래 창에 쓰던 내용</p>';
    assert.equal(api.focusComposer(route).ok, false);
    assert.equal(composer.textContent, '원래 창에 쓰던 내용');
    assert.equal(api.composerState(route).text, '원래 창에 쓰던 내용');
    composer.innerHTML = '<p></p>';
    assert.equal(api.focusComposer(route).ok, true);
    assert.equal(dom.window.document.activeElement, composer);
  } finally { dom.window.close(); }
});

test('dialogs and inline editors cannot become the live send composer', () => {
  const dom = makePage();
  try {
    const { document } = dom.window;
    document.querySelector('form').remove();
    document.querySelector('#chat-messages-200-1001').insertAdjacentHTML('beforeend', '<div role="textbox" contenteditable="true" data-slate-editor="true">editing an old message</div>');
    document.body.insertAdjacentHTML('beforeend', '<div role="dialog"><div role="textbox" contenteditable="true" data-slate-editor="true">dialog field</div></div>');
    const snap = dom.window.__vdcAdapter.snapshot();
    assert.equal(snap.hasDialog, true);
    assert.equal(snap.canSend, false);
    assert.equal(dom.window.__vdcAdapter.focusComposer(route).ok, false);
  } finally { dom.window.close(); }
});

test('Explorer opens only discovered conversations; arbitrary keys and chat links cannot navigate', () => {
  const dom = makePage();
  try {
    let clicked = 0;
    const target = dom.window.document.querySelector('a[href="/channels/100/201"]');
    target.addEventListener('click', event => { event.preventDefault(); clicked++; });
    const api = dom.window.__vdcAdapter;
    const channel = api.snapshot().channels.find(item => item.route === '/channels/100/201');
    assert.equal(api.open(channel.key).ok, true);
    assert.equal(clicked, 1);
    assert.equal(api.open('route:https://example.com/').ok, false);
    assert.equal(api.open('route:/channels/100/777').ok, false);
    assert.equal(api.open('javascript:alert(1)').ok, false);
  } finally { dom.window.close(); }
});

test('login pages do not expose a sendable conversation', () => {
  const dom = makePage('https://discord.com/login', '<!doctype html><body><form><input name="email"><input type="password"></form></body>');
  try {
    const api = dom.window.__vdcAdapter;
    const snap = api.snapshot();
    assert.equal(snap.loggedIn, false);
    assert.equal(snap.canSend, false);
    assert.equal(snap.rows.length, 0);
    assert.equal(api.focusComposer(route).ok, false);
  } finally { dom.window.close(); }
});

test('account identity comes only from the rendered account avatar, never a display name', () => {
  const dom=makePage();
  try {
    const api=dom.window.__vdcAdapter;
    assert.equal(api.snapshot().accountId,'999');
    const avatar=dom.window.document.querySelector('.panels_123 img');
    avatar.src='https://cdn.discordapp.com/avatars/888/avatar.png';
    assert.equal(api.snapshot().accountId,'888');
    avatar.remove();
    assert.equal(api.snapshot().accountId,'','an identical display name cannot identify an account');
    dom.window.history.pushState({},'','/login');
    assert.equal(api.snapshot().accountId,'');
  } finally {dom.window.close();}
});

test('a hidden old account panel cannot override the current account or own-message detection', () => {
  const dom=makePage();
  try {
    const {document}=dom.window;
    const api=dom.window.__vdcAdapter;
    const current=document.querySelector('.panels_123');
    const ownMessage=document.querySelector('#chat-messages-200-1003 h3');
    ownMessage.insertAdjacentHTML('afterbegin','<img class="avatar_123" src="https://cdn.discordapp.com/avatars/999/self.png">');
    current.insertAdjacentHTML('beforebegin','<div style="display:none"><section class="panels_old"><img src="https://cdn.discordapp.com/avatars/888/old.png"><span class="username_old">이전 계정</span></section></div>');
    let snapshot=api.snapshot();
    assert.equal(snapshot.accountId,'999');assert.equal(snapshot.rows[2].own,true);
    current.querySelector('img').src='https://cdn.discordapp.com/avatars/777/new.png';
    ownMessage.querySelector('img').src='https://cdn.discordapp.com/avatars/777/new.png';
    snapshot=api.snapshot();
    assert.equal(snapshot.accountId,'777','the next snapshot observes the visible account switch');
    assert.equal(snapshot.rows[2].own,true);
  } finally {dom.window.close();}
});

test('hidden account avatars and names are not identity evidence', () => {
  const dom=makePage();
  try {
    const {document}=dom.window;
    const api=dom.window.__vdcAdapter;
    const current=document.querySelector('.panels_123');
    current.insertAdjacentHTML('afterbegin','<div aria-hidden="true"><img src="https://cdn.discordapp.com/avatars/888/old.png"><span class="username_old">이전 계정</span></div>');
    assert.equal(api.snapshot().accountId,'999');
    current.querySelector('img[src*="/999/"]').hidden=true;
    assert.equal(api.snapshot().accountId,'','hidden avatars cannot identify an account');
    assert.equal(api.snapshot().rows[2].own,true,'a visible display name still supports the existing no-avatar fallback');
    current.querySelector('.username_123').hidden=true;
    assert.equal(api.snapshot().rows[2].own,false,'hidden display names cannot supply the fallback');
  } finally {dom.window.close();}
});

test('conflicting visible account panels are treated as unknown until the transition ends', () => {
  const dom=makePage();
  try {
    const {document}=dom.window;
    const api=dom.window.__vdcAdapter;
    document.body.insertAdjacentHTML('beforeend','<section class="panels_second"><img src="https://cdn.discordapp.com/avatars/888/second.png"><span class="username_second">다른 계정</span></section>');
    const ambiguous=api.snapshot();
    assert.equal(ambiguous.accountId,'');
    assert.equal(ambiguous.rows.some(row=>row.own),false);
    document.querySelector('.panels_second').remove();
    assert.equal(api.snapshot().accountId,'999');
    const duplicate=document.querySelector('.panels_123').cloneNode(true);
    document.body.append(duplicate);
    assert.equal(api.snapshot().accountId,'999','duplicate visible panels for the same ID are not conflicting identities');
    duplicate.remove();
    document.querySelector('.panels_123').append(duplicate);
    assert.equal(api.snapshot().accountId,'999','nested copies for the same account are deduplicated');
    duplicate.querySelector('img').src='https://cdn.discordapp.com/avatars/888/second.png';
    assert.equal(api.snapshot().accountId,'','a conflicting nested account panel is also ambiguous');
  } finally {dom.window.close();}
});

test('SPA route changes cannot expose old-room messages or a sendable composer', () => {
  const dom=makePage();
  try {
    const api=dom.window.__vdcAdapter;
    const next='/channels/100/201';
    dom.window.history.pushState({},'',next);
    const stale=api.snapshot();
    assert.equal(stale.routeReady,false);
    assert.equal(stale.canSend,false);
    assert.equal(stale.rows.length,0);
    assert.equal(api.focusComposer(next).ok,false);
    assert.equal(api.composerState(next).ok,false);
    dom.window.document.querySelector('[data-list-id="chat-messages"]').innerHTML='<li id="chat-messages-201-2001"><h3><span id="message-username-2001">새 친구</span></h3><div id="message-content-2001">새 방 메시지</div></li>';
    const ready=api.snapshot();
    assert.equal(ready.routeReady,true);
    assert.equal(ready.canSend,true);
    assert.equal(ready.rows.length,1);
    assert.equal(ready.rows[0].text,'새 방 메시지');
  } finally {dom.window.close();}
});

test('snapshot read reuse never survives visibility changes or a subsequent composer check', () => {
  const dom=makePage();
  try {
    const {document}=dom.window;
    const api=dom.window.__vdcAdapter;
    const form=document.querySelector('form');
    const list=document.querySelector('[data-list-id="chat-messages"]');
    assert.equal(api.snapshot().rows.length,3);
    list.parentElement.style.display='none';
    assert.equal(api.snapshot().rows.length,0);
    list.parentElement.style.display='block';
    assert.equal(api.snapshot().rows.length,3);
    assert.equal(api.snapshot().canSend,true);
    form.setAttribute('aria-hidden','true');
    assert.equal(api.composerState(route).ok,false,'a mutation after snapshot must be rechecked before sending');
    assert.equal(api.focusComposer(route).ok,false);
    assert.equal(api.snapshot().canSend,false);
    form.removeAttribute('aria-hidden');
    assert.equal(api.snapshot().canSend,true);
    const channel=document.querySelector('a[href="/channels/100/201"]');
    api.snapshot();
    channel.parentElement.hidden=true;
    assert.equal(api.open('route:/channels/100/201').ok,false,'open must not reuse discovery from the previous snapshot');
  } finally {dom.window.close();}
});

test('a long plain-text snapshot has bounded layout reads and does not clone every message', () => {
  const dom=makePage();
  try {
    const win=dom.window;
    const count=200;
    win.document.querySelector('[data-list-id="chat-messages"]').innerHTML=Array.from({length:count},(_,index)=>{
      const id=5000+index;
      return `<li id="chat-messages-200-${id}"><h3><span id="message-username-${id}">사용자</span></h3><div id="message-content-${id}">내용 ${index}</div></li>`;
    }).join('');
    let styles=0,queries=0,clones=0;
    const getStyle=win.getComputedStyle;
    win.getComputedStyle=(...args)=>{styles++;return getStyle.apply(win,args);};
    for(const prototype of [win.Document.prototype,win.Element.prototype]) {
      for(const method of ['querySelector','querySelectorAll']) {
        const original=prototype[method];
        prototype[method]=function(...args){queries++;return original.apply(this,args);};
      }
    }
    const cloneNode=win.Node.prototype.cloneNode;
    win.Node.prototype.cloneNode=function(...args){clones++;return cloneNode.apply(this,args);};
    const snapshot=win.__vdcAdapter.snapshot();
    assert.equal(snapshot.rows.length,count);
    assert.equal(snapshot.rows.at(-1).text,'내용 199');
    assert.equal(snapshot.canSend,true);
    assert.ok(styles<count*2+50,`shared ancestors should not trigger repeated layout reads (${styles})`);
    assert.ok(queries<count*8+100,`whole-list and plain-text scans should not be repeated (${queries})`);
    assert.ok(clones<20,`plain messages do not need detached DOM copies (${clones})`);
  } finally {dom.window.close();}
});

test('long channel categories are scanned once and are refreshed after a category edit or move', t => {
  const dom=makePage();
  try {
    const win=dom.window;
    const list=win.document.querySelector('[data-list-id="channels"]');
    const count=200;
    const channel=index=>`<li><a href="/channels/100/${200+index}"><span class="name_abc">채널 ${index}</span></a></li>`;
    list.innerHTML='<li id="category-a"><h3>첫 번째</h3></li>'+
      Array.from({length:count/2},(_,index)=>channel(index)).join('')+
      '<li id="category-b"><h3>두 번째</h3></li>'+
      Array.from({length:count/2},(_,index)=>channel(index+count/2)).join('');
    let categoryQueries=0;
    const query=win.Element.prototype.querySelector;
    win.Element.prototype.querySelector=function(selector){
      if(selector.includes('categoryName'))categoryQueries++;
      return query.call(this,selector);
    };
    const snapshot=win.__vdcAdapter.snapshot();
    const channels=snapshot.channels.filter(item=>item.kind==='channel');
    assert.equal(channels.length,count);
    assert.ok(channels.slice(0,100).every(item=>item.group==='첫 번째'));
    assert.ok(channels.slice(100).every(item=>item.group==='두 번째'));
    t.diagnostic(`category selector calls for ${count} channels: ${categoryQueries}`);
    assert.ok(categoryQueries<=count+2,`category discovery should be linear (${categoryQueries})`);
    const category=win.document.querySelector('#category-b');
    category.querySelector('h3').textContent='변경된 그룹';
    list.insertBefore(category,list.querySelector('a[href="/channels/100/250"]').parentElement);
    let refreshed=win.__vdcAdapter.snapshot().channels;
    assert.equal(refreshed.find(item=>item.id==='249').group,'첫 번째');
    assert.equal(refreshed.find(item=>item.id==='250').group,'변경된 그룹');
    assert.equal(refreshed.find(item=>item.id==='399').group,'변경된 그룹');
    category.remove();
    refreshed=win.__vdcAdapter.snapshot().channels;
    assert.ok(refreshed.filter(item=>item.kind==='channel').every(item=>item.group==='첫 번째'));
  } finally {dom.window.close();}
});
