'use strict';
// End-to-end Electron integration with a local Discord-shaped DOM fixture.
// The guest session's entire HTTPS protocol is intercepted; no real account or messages.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createFileLogger } = require('./helpers/file-logger.cjs');
const artifactDir = process.env.VDC_TEST_OUTPUT || path.resolve(__dirname, '../test-results/live-desktop');
fs.mkdirSync(artifactDir, { recursive:true });
const logger = createFileLogger(path.join(artifactDir, 'test.log'));
app.disableHardwareAcceleration();
process.env.VDC_TEST_PROFILE = path.join(artifactDir, 'profile');
const route = '/channels/@me/123';
const fixture = `<!doctype html><html><head><meta charset="utf-8"><title>Discord test fixture</title></head><body>
<nav class="guilds_123" aria-label="Servers"><a href="/channels/@me" data-list-item-id="guildsnav___home" aria-label="direct">direct</a></nav>
<aside class="sidebar_123"><nav class="privateChannels_123"><a href="/channels/@me/123"><span class="name_123">테스트 친구</span></a><a href="/channels/@me/456"><span class="name_123">다른 대화</span></a></nav></aside>
<div class="panels_123"><span class="username_123">테스트 사용자</span></div>
<main><div class="messagesWrapper_123"><div class="scroller_123" style="height:500px;overflow-y:auto"><ol data-list-id="chat-messages" id="messages">
<li id="chat-messages-123-900"><h3><span id="message-username-900">테스트 친구</span><time datetime="2026-11-03T12:00:00Z">21:00</time></h3><div id="message-content-900">에디터에서 실제 입력 기능을 검사합니다.</div></li>
</ol></div></div><form><div class="channelTextArea_123"><div role="textbox" contenteditable="true" data-slate-editor="true" class="slateTextArea_123" tabindex="0"><p><br></p></div></div></form></main>
<script>
history.replaceState({}, '', '${route}');
window.__sentTexts=[]; window.__enterCount=0; window.__delayAck=0; window.__delayClear=0; window.__renderBold=false;
window.__inputLog=[];
for(const type of ['focus','blur','keydown','keyup','keypress'])window.addEventListener(type,event=>window.__inputLog.push({type,key:event.key,focused:document.hasFocus(),active:document.activeElement?.getAttribute('role')}),true);
const composer=document.querySelector('[data-slate-editor]');
document.querySelectorAll('a[href]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();history.pushState({},'',link.getAttribute('href'));}));
composer.addEventListener('keydown',event=>{
  if(event.key!=='Enter'||event.shiftKey||event.isComposing)return;
  event.preventDefault(); window.__enterCount++;
  const text=composer.innerText.trim(); if(!text)return;
  window.__sentTexts.push(text);
  const clear=()=>{composer.innerHTML='<p><br></p>';};
  if(window.__delayClear)setTimeout(clear,window.__delayClear);else clear();
  const add=()=>{const id=Math.max(900,Number(sessionStorage.getItem('fixtureCounter')||900),...[...document.querySelectorAll('[id^="chat-messages-123-"]')].map(row=>Number(row.id.split('-').at(-1))||0))+1;sessionStorage.setItem('fixtureCounter',String(id));const row=document.createElement('li');row.id='chat-messages-123-'+id;const h=document.createElement('h3');const n=document.createElement('span');n.id='message-username-'+id;n.textContent='테스트 사용자';h.append(n);const time=document.createElement('time');time.dateTime=new Date().toISOString();h.append(time);const c=document.createElement('div');c.id='message-content-'+id;c.textContent=window.__renderBold&&text.startsWith('**')&&text.endsWith('**')?text.slice(2,-2):text;row.append(h,c);document.getElementById('messages').append(row);};
  if(window.__delayAck)setTimeout(add,window.__delayAck);else add();
});
</script></body></html>`;

app.whenReady().then(() => {
  session.fromPartition('persist:visual-discord-code').protocol.handle('https', () => new Response(fixture, { headers:{'content-type':'text/html; charset=utf-8'} }));
});
require(path.join(process.env.VDC_APP_ROOT || path.resolve(__dirname, '..'), 'main.js'));
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
const timer = setTimeout(() => {
  try { logger.error('Live integration timed out'); } finally { app.exit(1); }
},45000);
async function until(predicate, duration=15000) {
  const start=Date.now();
  while(Date.now()-start<duration) { try { const value=await predicate(); if(value)return value; } catch {} await delay(100); }
  throw new Error('Live integration condition timed out');
}
app.whenReady().then(async () => {
  try {
    const win=await until(()=>BrowserWindow.getAllWindows()[0]);
    const host=win.webContents;
    await until(()=>host.executeJavaScript('!!window.vdc?.sendMessage && !!document.getElementById("message-input")').catch(()=>false));
    const view=await until(()=>win.contentView.children[0]);
    const guest=view.webContents;
    await until(()=>host.executeJavaScript('document.getElementById("code-content").textContent.includes("에디터에서 실제 입력 기능")'));
    assert.ok(view.getBounds().x >= win.getContentSize()[0], 'native Discord must be offscreen in code mode');
    assert.equal(await guest.executeJavaScript('location.pathname'),route);
    // Windows hidden process launch can suppress the first show() even while
    // focus succeeds. Foreground polling tests need an explicitly visible host.
    win.show();await until(()=>win.isVisible());
    win.focus();host.focus();await until(()=>win.isFocused());
    await host.executeJavaScript(`if(document.getElementById('file-names-toggle').getAttribute('aria-pressed')==='true')document.getElementById('file-names-toggle').click();document.getElementById('file-names-toggle').click();`,true);
    const alias=await host.executeJavaScript('document.querySelector(".file-row.active .filename").textContent');
    assert.match(alias,/\.(jsx|tsx)$/);
    assert.notEqual(alias,'테스트 친구.tsx');
    assert.equal(await host.executeJavaScript('document.getElementById("tab-label").textContent'),alias);
    host.reload();
    await until(()=>host.executeJavaScript('document.getElementById("tab-label")?.textContent==='+JSON.stringify(alias)).catch(()=>false));
    assert.equal(await host.executeJavaScript('document.getElementById("file-names-toggle").getAttribute("aria-pressed")'),'true');
    await host.executeJavaScript(`document.getElementById('file-names-toggle').click();`,true);
    assert.equal(await host.executeJavaScript('document.getElementById("tab-label").textContent'),'테스트 친구.tsx');
    logger.log('PASS: Explorer aliases match tab, persist through renderer reload, and toggle back');
    fs.writeFileSync(path.join(artifactDir,'live-editor-before-send.png'),(await until(()=>host.capturePage())).toPNG());
    await until(()=>host.executeJavaScript('!document.getElementById("message-input").disabled'));
    await host.executeJavaScript('window.__historyNode = document.querySelector(".code-block[data-message-id=\\"chat-messages-123-900\\"]");');
    win.focus();host.focus();await until(()=>win.isFocused());
    const message='한글 전송 검사 "따옴표" <b>문자</b>';
    await host.executeJavaScript(`const input=document.getElementById('message-input');input.value=${JSON.stringify(message)};input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();`,true);
    host.sendInputEvent({type:'keyDown',keyCode:'Return'});
    host.sendInputEvent({type:'keyUp',keyCode:'Return'});
    await until(()=>guest.executeJavaScript('window.__sentTexts.length===1'));
    await until(()=>host.executeJavaScript('document.getElementById("message-input").value===""'));
    assert.equal(await guest.executeJavaScript('window.__sentTexts[0]'),message);
    assert.equal(await guest.executeJavaScript('window.__enterCount'),1);
    const displayedMessage=JSON.stringify(message).slice(1,-1);
    await until(()=>host.executeJavaScript(`document.getElementById('code-content').textContent.includes(${JSON.stringify(displayedMessage)})`));
    assert.equal(await host.executeJavaScript('!!document.getElementById("code-content").querySelector("b")'),false);
    logger.log('PASS: code input -> Discord editor insertion/Enter -> ordinary code rendering');
    await until(()=>host.executeJavaScript('!document.getElementById("message-input").disabled && document.activeElement===document.getElementById("message-input") && document.hasFocus()'));
    // Type the next draft without another click or focus call in either process.
    await host.insertText('클릭 없이 이어서 쓰는 다음 메시지');
    assert.equal(await host.executeJavaScript('document.getElementById("message-input").value'),'클릭 없이 이어서 쓰는 다음 메시지');
    await host.executeJavaScript(`document.getElementById('message-input').value='';document.getElementById('message-input').dispatchEvent(new Event('input',{bubbles:true}));`);
    logger.log('PASS: Enter send restores the enabled composer and accepts the next draft without clicking');
    assert.equal(await host.executeJavaScript('document.querySelectorAll(".live-message[data-message-id=\\"chat-messages-123-901\\"] .code-row").length'),1);
    await guest.executeJavaScript(`{
      const row=document.createElement('li');row.id='chat-messages-123-902';
      const h=document.createElement('h3');const name=document.createElement('span');name.id='message-username-902';name.textContent='테스트 친구';
      const time=document.createElement('time');time.dateTime=new Date().toISOString();h.append(name,time);
      const content=document.createElement('div');content.id='message-content-902';content.textContent='새 답장도 한 줄로 보여요';
      row.append(h,content);document.getElementById('messages').append(row);
    }`);
    await until(()=>host.executeJavaScript('document.querySelectorAll(".new-messages .live-message").length===2'));
    assert.equal(await host.executeJavaScript('document.querySelectorAll(".new-messages .live-message .code-row").length'),2);
    assert.equal(await host.executeJavaScript('window.__historyNode === document.querySelector(".code-block[data-message-id=\\"chat-messages-123-900\\"]")'),true);
    fs.writeFileSync(path.join(artifactDir,'live-compact-messages.png'),(await until(()=>host.capturePage())).toPNG());
    await guest.executeJavaScript(`window.__savedMessages=document.getElementById('messages').innerHTML;document.getElementById('messages').replaceChildren();history.pushState({},'','/channels/@me/456');`);
    await until(()=>host.executeJavaScript('document.getElementById("tab-label").textContent==="다른 대화.tsx"'));
    await guest.executeJavaScript(`document.getElementById('messages').innerHTML=window.__savedMessages;history.pushState({},'',${JSON.stringify(route)});`);
    await until(()=>host.executeJavaScript('document.getElementById("tab-label").textContent==="테스트 친구.tsx"'));
    assert.equal(await host.executeJavaScript('document.querySelectorAll(".live-message").length'),0);
    assert.equal(await host.executeJavaScript('document.querySelectorAll(".code-block[data-message-id]").length'),3);
    logger.log('PASS: live incoming/outgoing messages occupy one line each; reentry restores woven history');

    const wrong=await host.executeJavaScript(`window.vdc.sendMessage({text:'보내면 안 됨',route:'/channels/@me/456'})`,true);
    assert.equal(wrong.ok,false);
    assert.equal(await guest.executeJavaScript('window.__sentTexts.length'),1);
    await guest.executeJavaScript(`document.querySelector('[data-slate-editor]').textContent='원래 창 초안';`);
    const draft=await host.executeJavaScript(`window.vdc.sendMessage({text:'덮어쓰면 안 됨',route:${JSON.stringify(route)}})`,true);
    assert.equal(draft.ok,false);
    assert.equal(await guest.executeJavaScript(`document.querySelector('[data-slate-editor]').textContent`),'원래 창 초안');
    assert.equal(await guest.executeJavaScript('window.__sentTexts.length'),1);
    await guest.executeJavaScript(`document.querySelector('[data-slate-editor]').textContent='';`);
    logger.log('PASS: wrong conversation and existing native draft cannot be sent over');

    // A real iframe navigation starts the aggregate loading spinner without
    // replacing the Discord document or invalidating an active submission.
    const frameNavigations=[];
    const observeFrame=details=>frameNavigations.push({main:details.isMainFrame,same:details.isSameDocument});
    guest.on('did-start-navigation',observeFrame);
    await guest.executeJavaScript('window.__delayAck=800;window.__delayClear=500');
    win.focus();host.focus();await until(()=>win.isFocused());
    const nativeInsertText=guest.insertText.bind(guest);
    let insertionStarted=false, releaseInsertion;
    const insertionHold=new Promise(resolve=>{releaseInsertion=resolve;});
    guest.insertText=async text=>{await nativeInsertText(text);insertionStarted=true;await insertionHold;};
    const frameSend=host.executeJavaScript(`window.vdc.sendMessage({text:'임베드 로딩 중 전송',route:${JSON.stringify(route)}})`,true);
    await until(()=>insertionStarted);
    await guest.executeJavaScript(`{ const frame=document.createElement('iframe');frame.id='loading-embed';frame.srcdoc='<p>local embed fixture</p>';document.body.append(frame); }`);
    await until(()=>frameNavigations.some(event=>event.main===false));
    releaseInsertion();
    const frameResult=await frameSend;
    guest.insertText=nativeInsertText;
    assert.equal(frameResult.ok,true,'embedded frame loading must not cancel the active submission');
    assert.equal(frameResult.submitted,true);
    assert.equal(await guest.executeJavaScript('window.__enterCount'),2);
    guest.removeListener('did-start-navigation',observeFrame);
    await until(()=>guest.executeJavaScript('document.getElementById("messages").textContent.includes("임베드 로딩 중 전송")'));
    await guest.executeJavaScript(`window.__delayAck=0;window.__delayClear=0;document.getElementById('loading-embed').remove();`);
    logger.log('PASS: real embedded-frame navigation preserves the active submission');

    await host.executeJavaScript(`window.vdc.action('toggle-mode')`,true);
    assert.equal(view.getBounds().x,0);
    await host.executeJavaScript(`window.vdc.action('toggle-mode')`,true);
    assert.ok(view.getBounds().x >= win.getContentSize()[0]);
    await delay(250);
    fs.writeFileSync(path.join(artifactDir,'live-editor-fixture.png'),(await until(()=>host.capturePage())).toPNG());
    await host.executeJavaScript(`document.getElementById('file-names-toggle').click();`,true);
    fs.writeFileSync(path.join(artifactDir,'live-file-names.png'),(await until(()=>host.capturePage())).toPNG());
    logger.log('PASS: full code UI and original Discord view toggle');
    let backgroundReads=0;
    const originalExecute=guest.executeJavaScriptInIsolatedWorld.bind(guest);
    guest.executeJavaScriptInIsolatedWorld=(world,scripts,...args)=>{
      if(scripts.some(script=>script.code.includes('window.__vdcAdapter["snapshot"]')))backgroundReads++;
      return originalExecute(world,scripts,...args);
    };
    win.minimize();await until(()=>win.isMinimized());await delay(150);
    backgroundReads=0;await delay(1600);
    assert.equal(backgroundReads,0,'periodic Discord scans pause while minimized');
    win.restore();await until(()=>backgroundReads>0);
    guest.executeJavaScriptInIsolatedWorld=originalExecute;
    logger.log('PASS: historical DOM is retained for new messages and minimized scans resume on restore');

    await host.executeJavaScript(`window.__rendererReloadSentinel=true;document.getElementById('message-input').value='새로고침에도 보존할 초안';document.getElementById('message-input').dispatchEvent(new Event('input',{bubbles:true}));`);
    let mainReloads=0;
    const observeReload=details=>{if(details.isMainFrame&&!details.isSameDocument)mainReloads++;};
    guest.on('did-start-navigation',observeReload);
    win.focus();host.focus();await until(()=>win.isFocused());
    host.sendInputEvent({type:'keyDown',keyCode:'R',modifiers:[process.platform==='darwin'?'meta':'control']});
    host.sendInputEvent({type:'keyUp',keyCode:'R',modifiers:[process.platform==='darwin'?'meta':'control']});
    await until(()=>mainReloads===1);
    await until(()=>host.executeJavaScript('!document.getElementById("message-input").disabled'));
    assert.equal(await host.executeJavaScript('window.__rendererReloadSentinel'),true);
    assert.equal(await host.executeJavaScript('document.getElementById("message-input").value'),'새로고침에도 보존할 초안');
    guest.removeListener('did-start-navigation',observeReload);
    logger.log('PASS: standard reload shortcut refreshes Discord while preserving the code renderer and draft');

    await guest.executeJavaScript('window.__renderBold=true');
    await host.executeJavaScript(`{
      const input=document.getElementById('message-input');input.value='**서식 있는 메시지**';
      input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();document.getElementById('composer').requestSubmit();
    }`,true);
    await until(()=>host.executeJavaScript('document.getElementById("message-input").value==="" && !document.getElementById("message-input").disabled'));
    assert.equal(await guest.executeJavaScript('window.__sentTexts[0]'),'**서식 있는 메시지**');
    assert.equal(await guest.executeJavaScript('window.__enterCount'),1);
    logger.log('PASS: Markdown submission runs once and restores the composer');

    await guest.executeJavaScript('window.__delayAck=3000;window.__renderBold=false');
    let sendSnapshotReads=0;
    const executeBeforeSend=guest.executeJavaScriptInIsolatedWorld.bind(guest);
    guest.executeJavaScriptInIsolatedWorld=(world,scripts,...args)=>{
      if(scripts.some(script=>script.code.includes('window.__vdcAdapter["sendSnapshot"]')))sendSnapshotReads++;
      return executeBeforeSend(world,scripts,...args);
    };
    const acceptedStart=Date.now();
    await host.executeJavaScript(`{
      const input=document.getElementById('message-input');input.value='나중에 화면에 표시되는 메시지';
      input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();document.getElementById('composer').requestSubmit();
    }`,true);
    await until(()=>host.executeJavaScript('document.getElementById("message-input").value==="" && !document.getElementById("message-input").disabled && document.activeElement===document.getElementById("message-input")'),2000);
    const acceptedMs=Date.now()-acceptedStart;
    assert.ok(acceptedMs<2000,'submission must release the next draft without waiting for a rendered message');
    assert.equal(sendSnapshotReads,1,'only the pre-send snapshot is needed');
    assert.equal(await guest.executeJavaScript('document.getElementById("messages").textContent.includes("나중에 화면에 표시되는 메시지")'),false);
    assert.equal(await host.executeJavaScript('document.getElementById("connection-status").textContent'),'Discord 연결됨');
    assert.equal(await host.executeJavaScript('document.getElementById("inline-status").hidden'),true);
    await host.insertText('바로 이어서 작성하는 다음 초안');
    assert.equal(await host.executeJavaScript('document.getElementById("message-input").value'),'바로 이어서 작성하는 다음 초안');
    logger.log('PASS: next draft enabled in '+acceptedMs+'ms without result polling or confirmation status');
    await until(()=>host.executeJavaScript('document.getElementById("code-content").textContent.includes("나중에 화면에 표시되는 메시지")'));
    assert.equal(sendSnapshotReads,1,'late rendering must not trigger send-result reads');
    guest.executeJavaScriptInIsolatedWorld=executeBeforeSend;
    assert.equal(await host.executeJavaScript('document.getElementById("message-input").value'),'바로 이어서 작성하는 다음 초안');
    assert.equal(await host.executeJavaScript('document.getElementById("connection-status").textContent'),'Discord 연결됨');
    assert.equal(await guest.executeJavaScript('window.__enterCount'),2,'late rendering never resends');
    assert.equal(await host.executeJavaScript('document.getElementById("inline-status").hidden'),true);
    logger.log('PASS: ordinary message refresh preserves the next draft without confirmation prompts or duplicate sends');
    clearTimeout(timer);app.exit(0);
  } catch(error) {
    try {
      logger.error(error);
      const failedWindow=BrowserWindow.getAllWindows()[0];
      if(failedWindow&&!failedWindow.isDestroyed()) {
        logger.error('Window:',JSON.stringify({visible:failedWindow.isVisible(),minimized:failedWindow.isMinimized(),focused:failedWindow.isFocused()}));
        logger.error('Rendered:',await failedWindow.webContents.executeJavaScript('JSON.stringify({live:document.querySelectorAll(".live-message").length,status:document.getElementById("connection-status")?.textContent,error:document.getElementById("inline-status")?.textContent})').catch(()=>''));
        const failedGuest=failedWindow.contentView.children[0]?.webContents;
        if(failedGuest&&!failedGuest.isDestroyed()) {
          logger.error('Guest fixture:',await failedGuest.executeJavaScriptInIsolatedWorld(1001,[{code:'JSON.stringify(window.__vdcAdapter?.snapshot())'}]).catch(()=>''));
          logger.error('Native events:',await failedGuest.executeJavaScript('JSON.stringify({enters:window.__enterCount,sent:window.__sentTexts,focused:document.hasFocus(),events:window.__inputLog})').catch(()=>''));
        }
      }
    } finally {
      clearTimeout(timer);app.exit(1);
    }
  }
});
