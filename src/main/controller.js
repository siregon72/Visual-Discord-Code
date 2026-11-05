'use strict';

const { ACTIONS, IPC, AUTH_ROUTE, emptySnapshot, normalizeSnapshot, isSendRequest, isHistoryRequest } = require('../shared/contracts');
const { createAdapterClient, StaleGuestError } = require('./adapter-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const LOGIN_URL = 'https://discord.com/login?redirect_to=%2Fchannels%2F%40me';

/** Owns one window/guest lifecycle. Electron construction and permission policy live outside. */
function createController({ window, createGuest, guestSession, dialog, openExternal, isDiscordURL, adapterSource, transmitMessage,
  wait = delay, pollIntervalMs = 700, navigationAttempts = 60, navigationTimeoutMs = 10000, adapterTimeoutMs = 4000 }) {
  const invoke = createAdapterClient({ source: adapterSource, isDiscordURL, timeoutMs: adapterTimeoutMs });
  const knownRoutes = new Map([['route:/channels/@me', '/channels/@me']]);
  const knownGuilds = new Set();
  let guest = null, guestListeners = [], windowListeners = [], pollTimer = null, pendingRead = null;
  let disposed = false, guestEpoch = 0, documentEpoch = 0, operation = null;
  let snapshot = null, lastSnapshot = '', nativePinned = false, busy = true, ready = false, error = '', mode = 'native', authBoundary = false, accountId = '';
  let lastState = '', lastBounds = null;

  const alive = () => !disposed && !window.isDestroyed() && !window.webContents.isDestroyed();
  const guestAlive = target => !!target && !target.webContents.isDestroyed();
  const sameGuest = (target, epoch = guestEpoch) => alive() && guest === target && guestEpoch === epoch && guestAlive(target);

  function emit(channel, value) { if (alive()) window.webContents.send(channel, value); }
  function emitSnapshot(value = snapshot) {
    if (!value) return;
    const serialized = JSON.stringify(value);
    if (serialized !== lastSnapshot) { lastSnapshot = serialized; emit(IPC.snapshot, value); }
  }
  function layout() {
    if (!alive() || !guestAlive(guest)) return;
    const [width, height] = window.getContentSize();
    const bounds = { x: mode === 'native' ? 0 : width + 20, y: 76, width, height: Math.max(1, height - 100) };
    if (lastBounds?.target === guest && Object.keys(bounds).every(key => lastBounds.bounds[key] === bounds[key])) return;
    guest.setBounds(bounds);
    lastBounds = { target: guest, bounds };
  }
  function state() {
    const loginRequired = !snapshot || !String(snapshot.route).startsWith('/channels');
    mode = nativePinned || loginRequired || !!snapshot?.hasDialog ? 'native' : 'code';
    const history = guestAlive(guest) ? guest.webContents.navigationHistory : null;
    return { mode, connected: !!snapshot?.loggedIn && ready, busy, ready, error,
      sending: operation?.kind === 'send', opening: operation?.kind === 'open', clearing: operation?.kind === 'clear',
      loginRequired, canBack: !!history?.canGoBack(), canForward: !!history?.canGoForward() };
  }
  function publishState(force = false) {
    if (!alive()) return;
    const value = state(), serialized = JSON.stringify(value);
    layout();
    if (force || serialized !== lastState) { lastState = serialized; emit(IPC.state, value); }
  }
  function resetDiscovery() { knownRoutes.clear(); knownRoutes.set('route:/channels/@me', '/channels/@me'); knownGuilds.clear(); }
  function markNotReady(message = '') {
    ready = false; error = message;
    if (snapshot?.canSend) { snapshot = { ...snapshot, canSend: false }; emitSnapshot(); }
    publishState();
  }
  function invalidateDocument() {
    documentEpoch += 1; pendingRead = null;
    markNotReady();
  }
  function resetSnapshot() {
    resetDiscovery(); accountId = ''; snapshot = emptySnapshot(); lastSnapshot = '';
    emitSnapshot({ ...snapshot, reset: true });
    ready = false;
  }
  function applySnapshot(value) {
    const accountChanged = !!(value.loggedIn && accountId && value.accountId && accountId !== value.accountId);
    if (accountChanged) {
      resetDiscovery();
      if (operation) operation.cancelled = true;
      emitSnapshot({ ...value, reset: true });
    }
    if (AUTH_ROUTE.test(value.route)) {
      if (!authBoundary) {
        authBoundary = true; accountId = ''; resetDiscovery();
        if (operation) operation.cancelled = true;
        emitSnapshot({ ...value, reset: true });
      }
    } else if (value.loggedIn) { authBoundary = false; if (value.accountId) accountId = value.accountId; }
    snapshot = value;
    for (const channel of value.channels) knownRoutes.set(channel.key, channel.route);
    for (const guild of value.guilds) knownGuilds.add(guild.key);
    ready = true; error = '';
    emitSnapshot(); publishState();
    return value;
  }
  function readSnapshot() {
    const target = guest, epoch = guestEpoch, document = documentEpoch;
    if (!sameGuest(target, epoch)) return Promise.reject(new StaleGuestError());
    if (pendingRead?.target === target && pendingRead.document === document) return pendingRead.promise;
    const current = () => sameGuest(target, epoch) && documentEpoch === document;
    const entry = { target, document, promise: null };
    entry.promise = (async () => {
      try {
        const raw = await invoke(target.webContents, 'snapshot', [], current);
        const value = normalizeSnapshot(raw);
        const path = new URL(target.webContents.getURL()).pathname.replace(/\/$/, '');
        if (!current() || path !== value.route) throw new StaleGuestError();
        return applySnapshot(value);
      } catch (failure) {
        if (current()) {
          markNotReady(busy || failure instanceof StaleGuestError ? '' : 'Discord 화면을 읽지 못했습니다. 잠시 후 다시 시도하거나 새로고침해 주세요.');
        }
        throw failure;
      } finally { if (pendingRead === entry) pendingRead = null; }
    })();
    pendingRead = entry;
    return entry.promise;
  }
  async function poll() {
    if (!sameGuest(guest) || operation?.kind === 'clear' || operation?.kind === 'send') return;
    try { await readSnapshot(); } catch { /* A failed read disables composing; the next poll may recover. */ }
  }
  function periodicPoll() {
    // Keep the Discord guest connected while the host is hidden. Explicit reads
    // for navigation, sending and renderer recovery remain available through poll.
    if (!alive() || window.isMinimized?.() || window.isVisible?.() === false) return;
    return poll();
  }
  function listen(wc, event, handler) { wc.on(event, handler); guestListeners.push(() => wc.removeListener(event, handler)); }
  function runDetached(task) { Promise.resolve().then(task).catch(() => { /* Actions publish their own bounded error state. */ }); }
  function shortcuts(event, input) {
    if (input.type !== 'keyDown') return;
    const command = input.control || input.meta, key = String(input.key).toLowerCase();
    if (command && input.shift && key === 'd') { event.preventDefault(); runDetached(() => action('toggle-mode')); }
    // Prevent Electron's default Cmd/Ctrl+R menu action from reloading the code
    // renderer (and losing its drafts) or bypassing the active-send gate.
    if (input.key === 'F5' || (command && !input.alt && key === 'r')) { event.preventDefault(); runDetached(() => action('reload')); }
  }
  function detachGuest() {
    guestEpoch += 1; documentEpoch += 1; pendingRead = null; ready = false; lastBounds = null;
    for (const unlisten of guestListeners) unlisten();
    guestListeners = [];
    const previous = guest; guest = null;
    if (previous) {
      if (!window.isDestroyed()) window.contentView.removeChildView(previous);
      if (guestAlive(previous)) previous.webContents.close();
    }
  }
  function attachGuest() {
    if (!alive() || guestAlive(guest)) return;
    if (guest) detachGuest();
    const target = createGuest(); guest = target;
    const epoch = ++guestEpoch, wc = target.webContents;
    const current = () => sameGuest(target, epoch);
    target.setBackgroundColor('#1e1e1e');
    wc.setUserAgent(wc.getUserAgent().replace(/ Electron\/\S+/g, '').replace(/ visual-discord-code\/\S+/gi, ''));
    wc.setWindowOpenHandler(({ url }) => { if (current()) openExternal(url); return { action: 'deny' }; });
    listen(wc, 'will-navigate', (event, url) => { if (!isDiscordURL(url)) { event.preventDefault(); if (current()) openExternal(url); } });
    listen(wc, 'will-redirect', (event, url, _inPlace, isMainFrame) => { if (isMainFrame && !isDiscordURL(url)) { event.preventDefault(); if (current()) openExternal(url); } });
    listen(wc, 'did-start-navigation', (details, _url, inPlace, isMainFrame) => {
      // The loading spinner also covers embedded frames. Only replacing the main
      // document invalidates a send; SPA route changes are handled below.
      if (current() && (details.isMainFrame ?? isMainFrame) && !(details.isSameDocument ?? inPlace)) {
        busy = true; invalidateDocument();
      }
    });
    listen(wc, 'did-stop-loading', () => { if (current()) { busy = false; publishState(); runDetached(poll); } });
    listen(wc, 'dom-ready', () => { if (current()) runDetached(poll); });
    listen(wc, 'did-navigate-in-page', (_event, _url, isMainFrame = true) => {
      if (current() && isMainFrame) { invalidateDocument(); runDetached(poll); }
    });
    listen(wc, 'did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (current() && mainFrame && code !== -3) { busy = false; markNotReady('Discord에 연결하지 못했습니다. 새로고침을 눌러주세요.'); }
    });
    listen(wc, 'render-process-gone', () => { if (current()) { invalidateDocument(); busy = false; markNotReady('Discord 화면이 중단되었습니다. 새로고침을 눌러주세요.'); } });
    listen(wc, 'destroyed', () => { if (guest === target && alive()) { guestEpoch += 1; documentEpoch += 1; pendingRead = null; busy = false; markNotReady('Discord 화면이 닫혔습니다. 새로고침을 눌러주세요.'); } });
    listen(wc, 'before-input-event', shortcuts);
    busy = true; ready = false; error = ''; window.contentView.addChildView(target); publishState();
    Promise.resolve(wc.loadURL(LOGIN_URL)).catch(() => { if (current()) { busy = false; markNotReady('Discord에 연결하지 못했습니다. 새로고침을 눌러주세요.'); } });
  }
  function begin(kind) {
    if (!alive() || operation) return null;
    const token = { kind, cancelled: false }; operation = token; publishState(); return token;
  }
  function finish(token) { if (operation === token) { operation = null; publishState(); } }
  function operationCurrent(token, target, epoch) { return operation === token && !token.cancelled && sameGuest(target, epoch); }
  async function openConversation(key) {
    if (typeof key !== 'string' || (!knownRoutes.has(key) && !knownGuilds.has(key))) return { ok: false, error: '현재 대화 목록에서 선택해주세요.' };
    if (!ready || busy || !guestAlive(guest)) return { ok: false, error: 'Discord 연결을 확인한 뒤 다시 선택해주세요.' };
    const token = begin('open');
    if (!token) return { ok: false, error: '현재 작업을 확인한 뒤 대화를 바꿀 수 있습니다.' };
    const target = guest, epoch = guestEpoch;
    const current = () => operationCurrent(token, target, epoch);
    try {
      const before = await readSnapshot();
      if (!current() || before.hasDialog) return { ok: false, error: 'Discord 안내창을 먼저 닫아주세요.' };
      const result = await invoke(target.webContents, 'open', [key], current);
      if (!current()) throw new StaleGuestError();
      if (!result?.ok && knownRoutes.has(key)) {
        // loadURL itself may complete after navigation has begun; document epochs
        // prevent its earlier reads from being committed to the newly selected room.
        Promise.resolve(target.webContents.loadURL('https://discord.com' + knownRoutes.get(key))).catch(() => {
          if (current()) markNotReady('대화 화면을 불러오지 못했습니다. 새로고침 후 다시 선택해주세요.');
        });
      } else if (!result?.ok) return { ok: false, error: '목록이 변경되었습니다. 다시 선택해주세요.' };
      nativePinned = false; publishState();
      const expected = knownRoutes.get(key);
      const guildId = key.startsWith('guild:') ? key.slice(6) : '';
      const prefix = '/channels/' + (['home', '@me'].includes(guildId) ? '@me' : guildId);
      const deadline = Date.now() + navigationTimeoutMs;
      for (let attempt = 0; attempt < navigationAttempts && current() && Date.now() < deadline; attempt++) {
        await wait(100);
        if (!current()) break;
        try {
          const next = await readSnapshot();
          if (next.loggedIn && next.routeReady && (expected ? next.route === expected : next.route === prefix || next.route.startsWith(prefix + '/'))) return { ok: true };
        } catch { /* The selected document can still be loading. */ }
      }
      return { ok: false, error: '대화를 불러오지 못했습니다. 연결 상태를 확인한 뒤 다시 선택해주세요.' };
    } catch { return { ok: false, error: '대화를 열지 못했습니다. 잠시 후 다시 선택해주세요.' }; }
    finally { finish(token); }
  }
  async function sendMessage(request) {
    if (!isSendRequest(request)) return { ok: false, error: '메시지는 1~2,000자로 입력해주세요.' };
    if (!alive() || !window.isFocused() || state().mode !== 'code' || !ready || busy || error || !guestAlive(guest)) return { ok: false, error: '코드 채팅 창과 연결 상태를 확인한 뒤 다시 시도해주세요.' };
    const token = begin('send');
    if (!token) return { ok: false, error: '대화 전환이나 전송을 처리하고 있습니다.' };
    const target = guest, epoch = guestEpoch, document = documentEpoch;
    const current = () => operationCurrent(token, target, epoch) && documentEpoch === document;
    try {
      const readSendSnapshot = async () => {
        // Finish an earlier full read before the send preflight. While sending,
        // polling yields to this current-room-only readiness check.
        if (pendingRead) await pendingRead.promise;
        if (!current()) throw new StaleGuestError();
        const raw = await invoke(target.webContents, 'sendSnapshot', [], current);
        const path = new URL(target.webContents.getURL()).pathname.replace(/\/$/, '');
        if (!current() || raw?.route !== path) throw new StaleGuestError();
        const observation = normalizeSnapshot(raw);
        const sameConversation = snapshot?.route === observation.route &&
          !(accountId && observation.accountId && accountId !== observation.accountId);
        const value = sameConversation ? { ...observation, title: snapshot.title, guildName: snapshot.guildName,
          channels: snapshot.channels, guilds: snapshot.guilds } : observation;
        applySnapshot(value);
        if (!current()) throw new StaleGuestError();
        return value;
      };
      return await transmitMessage({ request: { text: request.text, route: request.route }, wc: target.webContents, readSnapshot,
        readSendSnapshot,
        callAdapter: (method, ...args) => invoke(target.webContents, method, args, current), isCurrent: current,
        isFocused: () => window.isFocused() && target.webContents.isFocused(),
        focus: () => { if (!current()) throw new StaleGuestError(); window.focus(); target.webContents.focus(); } });
    } catch { return { ok: false, error: '전송 요청 처리 중 연결이 끊겼습니다. 입력 내용은 그대로 남아 있습니다.' }; }
    finally {
      finish(token);
      if (alive()) { window.webContents.focus(); runDetached(poll); }
    }
  }
  async function clearSession() {
    const token = begin('clear');
    if (!token) return false;
    try {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '이 앱에서 로그아웃', message: '이 앱의 Discord 로그인 정보를 지울까요?',
        detail: '계정과 대화는 삭제되지 않습니다.', buttons: ['취소', '로그아웃'], defaultId: 0, cancelId: 0 });
      if (!alive() || operation !== token || token.cancelled || answer.response !== 1) return false;
      detachGuest(); resetSnapshot(); nativePinned = false; authBoundary = true; busy = true; publishState();
      // Wait until both storage operations finish before reusing the partition.
      await guestSession.clearStorageData(); await guestSession.clearCache();
      if (!alive() || operation !== token || token.cancelled) return false;
      attachGuest(); return true;
    } catch {
      if (alive()) { busy = false; markNotReady('로그인 정보를 정리하지 못했습니다. 앱을 다시 실행한 뒤 확인해주세요.'); }
      return false;
    } finally { finish(token); }
  }
  async function pageHistory(request) {
    if (!isHistoryRequest(request) || operation || !ready || busy || request.route !== snapshot?.route || !guestAlive(guest)) return { ok: false };
    const target = guest, epoch = guestEpoch, document = documentEpoch;
    try { return await invoke(target.webContents, 'scroll', [request.direction, request.route], () => sameGuest(target, epoch) && document === documentEpoch); }
    catch { return { ok: false }; }
  }
  async function action(name) {
    if (!ACTIONS.has(name) || !alive()) return false;
    if (name === 'state') { publishState(true); if (snapshot) emit(IPC.snapshot, snapshot); runDetached(poll); return true; }
    if (name === 'minimize') { window.minimize(); return true; }
    if (name === 'maximize') { window.isMaximized() ? window.unmaximize() : window.maximize(); return true; }
    if (name === 'close') { window.close(); return true; }
    if (name === 'clear-session') return clearSession();
    if (operation) return false;
    switch (name) {
      case 'connect': nativePinned = !snapshot?.loggedIn; attachGuest(); break;
      case 'toggle-mode': nativePinned = mode !== 'native'; break;
      case 'home': nativePinned = false; break;
      case 'reload':
        if (!guestAlive(guest)) attachGuest();
        else { busy = true; invalidateDocument(); guest.webContents.reload(); }
        break;
      case 'back': case 'forward': {
        const history = guestAlive(guest) ? guest.webContents.navigationHistory : null;
        const backward = name === 'back';
        if (history && (backward ? history.canGoBack() : history.canGoForward())) {
          invalidateDocument(); backward ? history.goBack() : history.goForward();
        }
        break;
      }
      default: return false;
    }
    publishState(); return true;
  }
  function start() {
    if (!alive() || pollTimer) return;
    if (typeof window.on === 'function' && typeof window.removeListener === 'function') {
      const resume = () => runDetached(poll);
      for (const event of ['restore', 'show']) {
        window.on(event, resume);
        windowListeners.push(() => window.removeListener(event, resume));
      }
    }
    attachGuest(); pollTimer = setInterval(() => runDetached(periodicPoll), pollIntervalMs);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (operation) operation.cancelled = true;
    clearInterval(pollTimer); pollTimer = null;
    for (const unlisten of windowListeners) unlisten();
    windowListeners = [];
    detachGuest(); resetDiscovery(); snapshot = null;
  }
  return { start, dispose, layout, shortcuts, action, openConversation, sendMessage, pageHistory, readSnapshot, poll, getState: state };
}

module.exports = { createController };
