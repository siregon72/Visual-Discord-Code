'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const api = window.vdc;
  const { createModel, createExplorer, createFileNames, renderCodeDocument, renderCompactMessages, reactIcon } = window.VDCUI;
  const model = createModel();
  const fileNames = createFileNames();
  const collapsed = new Set();
  const cleanups = [];
  const recoverableSends = new Map();
  const recoveryNotice = '전송 확인이 지연되고 있습니다. 확인되면 자동으로 입력을 다시 사용할 수 있습니다.';
  const unresolvedNotice = '전송 여부가 불확실합니다. 대화에 표시된 내용을 확인한 뒤 입력을 다시 사용해 주세요.';
  let snap = model.snapshot;
  let state = model.connection;
  let level = 2, lines = 0;
  let manualHelp = false, composing = false, disposed = false;
  let pendingSend = null, pendingOpen = null, pendingHistory = null;
  let pendingComposerFocus = null;
  let toastTimer, historyTimer, recoveryTimer;
  let codeSignature = '', sendError = '', readError = '';
  let codeCache = null;

  function listen(element, name, callback, options) {
    element.addEventListener(name, callback, options);
    cleanups.push(() => element.removeEventListener(name, callback, options));
  }
  function current(token) { return !disposed && token.epoch === model.epoch; }
  function hidePreview() {
    $('media-preview').hidden = true;
    $('preview-image').removeAttribute('src');
    $('preview-name').textContent = '';
  }
  function toast(message) {
    if (disposed) return;
    $('toast').textContent = typeof message === 'string' ? message : '요청을 처리하지 못했습니다.';
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 7000);
  }
  async function action(name) {
    try { return await api?.action(name); }
    catch (error) { toast('요청을 처리하지 못했습니다. ' + (error?.message || '다시 시도해 주세요.')); return false; }
  }
  function resizeInput() {
    $('message-input').style.height = 'auto';
    $('message-input').style.height = Math.min(110, Math.max(28, $('message-input').scrollHeight)) + 'px';
  }
  function canCompose() {
    return !disposed && !readError && !!api?.sendMessage && model.canCompose({ manualHelp, sending: !!pendingSend, opening: !!pendingOpen });
  }
  function restoreComposerFocus() {
    const token = pendingComposerFocus;
    if (!token) return;
    if (!current(token) || snap.route !== token.route || manualHelp || state.mode !== 'code' ||
      !snap.loggedIn || snap.hasDialog || (model.uncertainties.has(token.route) && !recoverableSends.has(token.route))) {
      pendingComposerFocus = null;
      return;
    }
    const input = $('message-input');
    // The IPC receipt, sending state and cleared native draft can arrive separately.
    // Retain this request until all compose gates are open, instead of trying once.
    if (!canCompose() || input.disabled || $('composer-area').hidden) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement &&
      active !== input && active !== $('send')) {
      pendingComposerFocus = null;
      return;
    }
    pendingComposerFocus = null;
    input.focus({ preventScroll: true });
  }
  function updateStatus() {
    const sending = !!pendingSend || state.sending;
    const opening = !!pendingOpen || state.opening;
    const error = readError || state.error;
    $('mode').textContent = state.mode === 'native' ? '⌘ 코드 화면' : '◫ 원래 화면';
    $('connect').hidden = snap.loggedIn;
    $('connection-status').textContent = error || (sending ? '전송 확인 중…' : opening ? '대화 여는 중…' : state.clearing ? '로그아웃 중…' : state.busy ? 'Discord 연결 중…' : snap.loggedIn ? 'Discord 연결됨' : 'Discord 로그인이 필요합니다');
    document.querySelector('.statusbar').classList.toggle('pending', sending || !!error);
    document.querySelector('.statusbar').classList.toggle('disconnected', !snap.loggedIn);
    $('message-input').disabled = !canCompose();
    $('send').disabled = !canCompose() || !$('message-input').value.trim();
    let notice = error || (recoverableSends.has(snap.route) ? recoveryNotice : sendError);
    if (!notice && model.uncertainties.has(snap.route)) notice = unresolvedNotice;
    if (!notice && snap.hasDialog && state.mode === 'code') notice = 'Discord에 확인할 창이 열려 있습니다. 오른쪽 위 원래 화면에서 확인해 주세요.';
    if (!notice && snap.draftText && !sending) notice = '원래 Discord 입력창에 작성 중인 내용이 있습니다. 원래 화면에서 내용을 먼저 확인해 주세요.';
    $('inline-status').replaceChildren();
    if (notice) $('inline-status').append(document.createTextNode(notice));
    if (model.uncertainties.has(snap.route)) {
      const checked = document.createElement('button');
      checked.textContent = '확인 후 입력 다시 사용'; checked.className = 'acknowledge';
      checked.addEventListener('click', () => { model.uncertainties.delete(snap.route); recoverableSends.delete(snap.route); sendError = ''; updateStatus(); $('message-input').focus(); });
      $('inline-status').append(checked);
    }
    $('inline-status').hidden = !notice;
    $('composer-hint').textContent = sending ? '// 전송 결과를 확인하고 있습니다.' : `// Enter로 전송 · Shift+Enter로 줄 바꿈${$('message-input').value.length > 1600 ? ` · ${$('message-input').value.length}/2000` : ''}`;
    restoreComposerFocus();
  }
  async function openConversation(key) {
    if (pendingSend || pendingOpen || state.sending || state.opening || state.clearing || !api?.openConversation) return;
    const token = { epoch: model.epoch };
    pendingOpen = token; manualHelp = false; sendError = '';
    updateStatus(); renderCode();
    try {
      const result = await api.openConversation(key);
      if (current(token) && !result?.ok) toast(result?.error || '대화를 열지 못했습니다. 새로고침 후 다시 시도해 주세요.');
    } catch (error) { if (current(token)) toast(error?.message || '대화를 열지 못했습니다.'); }
    finally { if (pendingOpen === token) { pendingOpen = null; if (!disposed) updateStatus(); } }
  }
  const explorer = createExplorer({ tree: $('tree'), openConversation, showHelp, fileNames });
  function renderTree() {
    fileNames.assign(model.channels.values());
    $('file-names-toggle').setAttribute('aria-pressed', String(fileNames.enabled));
    const label = fileNames.enabled ? '원래 대화방 이름으로 표시' : '코드 파일명으로 표시';
    $('file-names-toggle').setAttribute('aria-label', label);
    $('file-names-toggle').title = label;
    explorer.render(snap, model.channels, model.guilds, collapsed, manualHelp);
  }
  function renderCode(forceBottom = false, force = false) {
    const help = manualHelp || (!snap.loggedIn && !snap.title && !snap.rows.length);
    const channel = model.channels.get(snap.route);
    const name = fileNames.filename({ route: snap.route, name: channel?.name || snap.title || 'inbox' });
    const contextKey = JSON.stringify([model.epoch, snap.loggedIn, snap.route, level, snap.canSend]);
    const rowKeys = snap.rows.map(message => JSON.stringify(message));
    const liveFlags = snap.rows.map(message => model.liveMessageIds.has(message.id));
    const signature = JSON.stringify([contextKey, help, name, snap.guildName, rowKeys, liveFlags]);
    if (signature === codeSignature && !force) return;
    codeSignature = signature;
    const scroll = $('code-scroll');
    const stick = forceBottom || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 70;
    const oldHeight = scroll.scrollHeight, oldTop = scroll.scrollTop;
    hidePreview();
    $('tab-label').textContent = help ? 'README.md' : name;
    $('language-status').textContent = help ? 'Markdown' : name.endsWith('.jsx') ? 'JavaScript React' : 'TypeScript React';
    $('file-language').textContent = help ? 'Markdown' : name.endsWith('.jsx') ? 'React JSX' : 'React TSX';
    $('tab-icon').innerHTML = help ? '<span class="md-icon">M↓</span>' : reactIcon;
    $('breadcrumb').textContent = help ? 'visual-discord-code  ›  README.md' : `${channel?.kind === 'dm' || snap.route.includes('/@me/') ? 'direct' : snap.guildName || channel?.group || 'channels'}  ›  ${name}`;
    $('composer-area').hidden = help || !snap.canSend;
    if (help) {
      codeCache = null;
      $('code-content').innerHTML = `<article class="readme-content"><div class="eyebrow">VISUAL DISCORD CODE</div><h1>대화를 코드처럼.</h1><p class="readme-lead">왼쪽의 <code>이름.tsx</code> 파일을 열면 실제 Discord 대화가 표시됩니다.<br>마지막 <code>setDraft("…");</code> 줄에 입력하고 Enter로 보내세요.</p>${!snap.loggedIn ? '<p>먼저 Discord 계정에 로그인하세요. 로그인 후 자동으로 코드 화면으로 돌아옵니다.</p><button id="help-connect">Discord 로그인</button>' : '<p>서버 폴더를 누르면 채널을 불러옵니다. DM은 <code>direct</code> 폴더에 표시됩니다.</p>'}<h2>단축키</h2><p><kbd>Enter</kbd> 전송 · <kbd>Shift+Enter</kbd> 줄 바꿈<br><kbd>Ctrl+B</kbd> 탐색기 표시<br><kbd>Ctrl+Shift+D</kbd> 원래 Discord 화면 전환</p><h2>첨부와 이전 대화</h2><p>첨부는 <code>asset("파일명")</code>으로 표시됩니다. 이미지 파일에 마우스를 올리면 미리보기가 뜹니다.<br>맨 위에서 더 위로 스크롤하면 이전 대화를 불러옵니다. 새 파일 첨부·통화 등은 오른쪽 위 <strong>원래 화면</strong>에서 사용할 수 있습니다.</p><p class="readme-footer">이 화면에 보이는 메시지는 실제 대화입니다. 대화는 React의 상태·함수·JSX 사이에 표시됩니다. 줄에 마우스를 올리면 보낸 사람과 시간을 확인할 수 있습니다. 장식용 코드는 실행되지 않습니다.</p></article>`;
      $('help-connect')?.addEventListener('click', () => { void action('connect'); });
      scroll.scrollTop = 0;
      return;
    }
    const content = $('code-content');
    const previousCount = codeCache?.rowKeys.length ?? 0;
    const liveSection = content.querySelector('.new-messages');
    // A compact tail append cannot change previous source, classifications, or
    // attachment indices. Everything else uses the complete renderer below.
    const reuseDocument = !force && codeCache?.contextKey === contextKey &&
      previousCount <= rowKeys.length && (previousCount > 0 || rowKeys.length === 0) &&
      codeCache.rowKeys.every((key, index) => key === rowKeys[index] && codeCache.liveFlags[index] === liveFlags[index]) &&
      liveFlags.slice(previousCount).every(Boolean) &&
      codeCache.liveFlags.some(Boolean) === !!liveSection;
    if (reuseDocument) {
      if (rowKeys.length > previousCount) {
        const entries = snap.rows.slice(previousCount).map((message, offset) => ({ message, index: previousCount + offset }));
        const appended = renderCompactMessages(entries, lines, !liveSection);
        (liveSection || content).insertAdjacentHTML('beforeend', appended.html);
        lines = appended.lines;
      }
    } else {
      const rendered = renderCodeDocument(snap, level, model.liveMessageIds);
      lines = rendered.lines;
      content.innerHTML = rendered.html;
    }
    codeCache = { contextKey, rowKeys, liveFlags };
    $('composer-line').textContent = String(lines + 1);
    $('cursor-status').textContent = `Ln ${lines + 1}, Col ${$('message-input').selectionStart + 1}`;
    if (stick) scroll.scrollTop = scroll.scrollHeight;
    else if (pendingHistory?.route === snap.route) scroll.scrollTop = oldTop + scroll.scrollHeight - oldHeight;
  }
  function showHelp() { pendingComposerFocus = null; manualHelp = true; renderTree(); renderCode(); updateStatus(); }
  function syncLayout() {
    const visible = !$('sidebar').classList.contains('is-hidden');
    $('explorer-toggle').classList.toggle('selected', visible);
    $('layout-sidebar').setAttribute('aria-pressed', String(visible));
    $('layout-wrap').setAttribute('aria-pressed', String(document.querySelector('.editor').classList.contains('wrap-lines')));
  }
  function toggleSidebar() { $('sidebar').classList.toggle('is-hidden'); syncLayout(); }
  function toggleWrap() { document.querySelector('.editor').classList.toggle('wrap-lines'); syncLayout(); }
  function density() { level = [0, 2, 4, 8][([0, 2, 4, 8].indexOf(level) + 1) % 4]; $('spaces').textContent = `Spaces: ${level}`; renderCode(false, true); }

  function completeSend(token, text) {
    if (!current(token)) return;
    const route = token.route, input = $('message-input');
    model.uncertainties.delete(route); recoverableSends.delete(route);
    if (model.draftVersions.get(route) === token.revision && model.drafts.get(route) === text) {
      model.saveDraft(route, '');
      if (snap.route === route && input.value === text) { input.value = ''; resizeInput(); }
    }
    if (snap.route === route) {
      if ($('toast').textContent === sendError) { clearTimeout(toastTimer); $('toast').hidden = true; }
      sendError = '';
      $('code-scroll').scrollTop = $('code-scroll').scrollHeight;
    }
  }

  function reconcileSend() {
    clearTimeout(recoveryTimer);
    let nextExpiry = Infinity;
    for (const [route, entry] of recoverableSends) {
      // A much later, unrelated message with identical text is not a receipt.
      const remaining = entry.receipt.startedAt + 60000 - Date.now();
      if (!current(entry.token) || remaining <= 0 || !model.uncertainties.has(route)) {
        if (current(entry.token) && route === snap.route && model.uncertainties.has(route)) sendError = unresolvedNotice;
        recoverableSends.delete(route); continue;
      }
      if (route === snap.route && snap.loggedIn && snap.routeReady) {
        const result = window.VDCSendReceipt.observeReceipt(entry.receipt, snap);
        if (result.status === 'confirmed') { completeSend(entry.token, entry.text); continue; }
        if (['failed', 'ambiguous', 'changed'].includes(result.status)) { sendError = unresolvedNotice; recoverableSends.delete(route); continue; }
      }
      nextExpiry = Math.min(nextExpiry, remaining);
    }
    if (Number.isFinite(nextExpiry)) recoveryTimer = setTimeout(() => { reconcileSend(); if (!disposed) updateStatus(); }, nextExpiry + 1);
  }

  function receiveSnapshot(value) {
    if (disposed) return;
    const change = model.receiveSnapshot(value, $('message-input').value);
    if (!change) { readError = '대화 화면을 읽지 못했습니다. 새로고침 후 다시 시도해 주세요.'; updateStatus(); return; }
    readError = ''; snap = model.snapshot;
    if (change.routeChanged || change.reset) {
      pendingComposerFocus = null;
      $('message-input').value = change.draft;
      sendError = ''; manualHelp = false; composing = false;
      pendingHistory = null; clearTimeout(historyTimer); resizeInput();
    }
    if (change.reset) {
      pendingSend = null; pendingOpen = null; collapsed.clear();
      recoverableSends.clear(); clearTimeout(recoveryTimer);
      clearTimeout(toastTimer); $('toast').hidden = true;
    }
    reconcileSend();
    renderTree(); renderCode(change.routeChanged); updateStatus();
  }
  function receiveState(value) {
    if (disposed || !model.receiveState(value)) return;
    state = model.connection; updateStatus();
  }
  async function submit(event) {
    event.preventDefault();
    if (composing || !canCompose()) return;
    const input = $('message-input');
    const text = input.value;
    if (!text.trim()) return;
    if (text.length > 2000) { toast('메시지는 2,000자까지 보낼 수 있습니다.'); return; }
    const route = snap.route;
    model.saveDraft(route, text);
    const token = { epoch: model.epoch, route, revision: model.draftVersions.get(route) };
    pendingSend = token; pendingComposerFocus = token; sendError = ''; updateStatus();
    try {
      const result = await api.sendMessage({ text, route });
      if (!current(token)) return;
      if (result?.ok) {
        completeSend(token, text);
      } else {
        if (result?.uncertain) model.uncertainties.add(route);
        const message = typeof result?.error === 'string' ? result.error : '전송하지 못했습니다. 입력 내용은 그대로 남아 있습니다.';
        if (snap.route === route) sendError = message;
        if (result?.uncertain && result.submitted === true && result.receipt?.route === route && result.receipt.text === text &&
          Number.isFinite(result.receipt.startedAt) && window.VDCSendReceipt) {
          recoverableSends.set(route, { token, text, receipt: result.receipt });
          reconcileSend();
        }
        if ((!recoverableSends.has(route) && model.uncertainties.has(route)) || !result?.uncertain) toast(snap.route === route ? sendError || message : message);
      }
    } catch {
      if (!current(token)) return;
      model.uncertainties.add(route);
      const message = '전송 결과를 확인하지 못했습니다. 원래 화면에서 확인해 주세요.';
      if (snap.route === route) sendError = message;
      toast(message);
    } finally {
      if (pendingSend === token) { pendingSend = null; if (!disposed) updateStatus(); }
    }
  }

  // Decorative editor chrome is intentionally inert; only real chat controls bind actions.
  document.querySelectorAll('.menubar button, .navigation-controls button, .title-search button, .title-search input, .layout-controls button, .activity button:not(#explorer-toggle)').forEach(control => {
    control.disabled = true; control.tabIndex = -1; control.classList.add('decorative-control'); control.removeAttribute('title');
  });
  listen($('composer'), 'submit', submit);
  listen(document, 'pointerdown', event => {
    if (pendingComposerFocus && !$('composer').contains(event.target)) pendingComposerFocus = null;
  });
  listen(document, 'focusin', event => {
    if (pendingComposerFocus && event.target !== $('message-input') && event.target !== $('send') &&
      event.target !== document.body && event.target !== document.documentElement) pendingComposerFocus = null;
  });
  listen(window, 'focus', restoreComposerFocus);
  listen($('message-input'), 'compositionstart', () => { composing = true; });
  listen($('message-input'), 'compositionend', () => { composing = false; });
  listen($('message-input'), 'keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !composing) { event.preventDefault(); $('composer').requestSubmit(); }
  });
  listen($('message-input'), 'input', () => { model.saveDraft(snap.route, $('message-input').value); resizeInput(); updateStatus(); $('cursor-status').textContent = `Ln ${lines + 1}, Col ${$('message-input').selectionStart + 1}`; });
  listen($('explorer-toggle'), 'click', toggleSidebar);
  listen($('tab-home'), 'click', showHelp);
  listen($('spaces'), 'click', density);
  listen($('outline-toggle'), 'click', () => { $('outline').hidden = !$('outline').hidden; });
  listen($('file-names-toggle'), 'click', () => { fileNames.toggle(); renderTree(); renderCode(); });
  listen($('toggle-wrap'), 'click', toggleWrap);
  listen($('connect'), 'click', () => { void action('connect'); });
  listen($('logout'), 'click', () => { void action('clear-session'); });
  document.querySelectorAll('[data-action]:not(.decorative-control)').forEach(button => listen(button, 'click', () => { void action(button.dataset.action); }));
  listen(document, 'keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b') { event.preventDefault(); toggleSidebar(); }
  });
  listen($('code-scroll'), 'wheel', async event => {
    if (!event.deltaY || event.ctrlKey) return;
    const scroller = $('code-scroll');
    const direction = event.deltaY < 0 ? -1 : 1;
    const atEdge = direction < 0 ? scroller.scrollTop <= 1 : scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (!atEdge || disposed || pendingHistory || readError || !api?.pageHistory ||
      !model.canReadHistory({ manualHelp, sending: !!pendingSend, opening: !!pendingOpen })) return;
    const token = { route: snap.route, epoch: model.epoch };
    pendingHistory = token;
    try { await api.pageHistory({ direction, route: token.route }); }
    catch { /* The next snapshot or manual reload can recover a history read. */ }
    finally {
      if (pendingHistory === token) historyTimer = setTimeout(() => { if (pendingHistory === token) pendingHistory = null; }, 900);
    }
  }, { passive: true });
  listen($('code-content'), 'mouseover', event => {
    const element = event.target.closest?.('.code-media');
    if (!element) return;
    if (event.relatedTarget && element.contains(event.relatedTarget)) return;
    hidePreview();
    const media = snap.rows[Number(element.dataset.row)]?.media?.[Number(element.dataset.media)];
    if (!media?.url) return;
    let url;
    try { url = new URL(media.url); } catch { return; }
    if (url.protocol !== 'https:' || url.username || url.password || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) return;
    if (!/image|photo/i.test(media.type) && !/\.(png|jpe?g|gif|webp|avif)(?:\?|$)/i.test(url.href)) return;
    $('preview-image').src = url.href; $('preview-name').textContent = media.name || '첨부 이미지'; $('media-preview').hidden = false;
  });
  listen($('code-content'), 'mouseout', event => {
    const element = event.target.closest?.('.code-media');
    if (element && (!event.relatedTarget || !element.contains(event.relatedTarget))) hidePreview();
  });
  listen($('code-scroll'), 'scroll', hidePreview);
  for (const unsubscribe of [api?.onSnapshot?.(receiveSnapshot), api?.onState?.(receiveState)]) if (typeof unsubscribe === 'function') cleanups.push(unsubscribe);
  listen(window, 'beforeunload', () => {
    disposed = true; pendingComposerFocus = null; recoverableSends.clear(); clearTimeout(recoveryTimer); clearTimeout(toastTimer); clearTimeout(historyTimer);
    for (const cleanup of cleanups) cleanup();
  }, { once: true });
  renderTree(); renderCode(); updateStatus();
  if (api) void action('state');
  else { readError = '이 화면은 Visual Discord Code 실행 파일에서 열어 주세요.'; updateStatus(); }
})();
