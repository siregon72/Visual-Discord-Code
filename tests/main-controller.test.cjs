'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createController } = require('../src/main/controller');
const { isDiscordURL } = require('../navigation');

const route = '/channels/@me/123';
const laterRoute = '/channels/@me/456';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (current = route) => ({ loggedIn: true, route: current, accountId: '100', title: '친구', guildName: 'direct',
  guilds: [], channels: [{ route, name: '친구' }, { route: laterRoute, name: '다른 친구' }],
  rows: [{ id: 'old', text: '이전 내용', own: false, media: [] }], canSend: true, routeReady: true, hasDialog: false, draftText: '' });

async function setup(options = {}) {
  const events = [], guests = [], calls = { execute: 0, transport: 0, dialogs: 0, clear: 0, bounds: 0 };
  let hostClosed = false;
  const window = Object.assign(new EventEmitter(), {
    minimized: false, visible: true, contentSize: [1440, 940],
    isDestroyed: () => hostClosed, isFocused: () => true, getContentSize: () => window.contentSize, focus() {},
    isMinimized: () => window.minimized, isVisible: () => window.visible,
    webContents: { isDestroyed: () => hostClosed, send: (channel, value) => events.push({ channel, value }), focus() {} },
    contentView: { addChildView() {}, removeChildView() {} },
    minimize() {}, isMaximized: () => false, maximize() {}, close() { hostClosed = true; }
  });
  let behavior = async method => method === 'snapshot' ? snapshot() : { ok: true };
  function createGuest() {
    const wc = new EventEmitter();
    Object.assign(wc, { url: '', destroyed: false, getURL: () => wc.url, isDestroyed: () => wc.destroyed,
      getUserAgent: () => 'Electron/45', setUserAgent() {}, setWindowOpenHandler() {}, focus() {},
      loadURL: async url => { wc.url = url; }, reload: () => wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }),
      close: () => { wc.destroyed = true; wc.emit('destroyed'); },
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScriptInIsolatedWorld: (_world, scripts) => {
        calls.execute += 1;
        const method = scripts[0].code.match(/window\.__vdcAdapter\["([^"]+)"\]/)[1];
        return behavior(method, wc);
      }
    });
    const view = { webContents: wc, setBounds(bounds) { calls.bounds += 1; this.bounds = bounds; }, setBackgroundColor() {} };
    guests.push(view); return view;
  }
  const controller = createController({ window, createGuest, isDiscordURL, adapterSource: '', openExternal() {},
    guestSession: { clearStorageData: async () => { calls.clear += 1; return options.clear?.(); }, clearCache: async () => {} },
    dialog: { showMessageBox: async () => { calls.dialogs += 1; return options.dialog ? options.dialog() : { response: 1 }; } },
    transmitMessage: async args => { calls.transport += 1; return options.transport ? options.transport(args) : { ok: true }; },
    wait: async () => {}, pollIntervalMs: 100000, navigationAttempts: 2, adapterTimeoutMs: 100,
    ...options.controller
  });
  controller.start();
  guests[0].webContents.url = 'https://discord.com' + route;
  guests[0].webContents.emit('did-stop-loading');
  await controller.readSnapshot();
  return { controller, window, guests, events, calls, setBehavior(fn) { behavior = fn; }, closeHost() { hostClosed = true; controller.dispose(); } };
}

test('concurrent snapshot requests share a read and an old document cannot overwrite a new route', async () => {
  const h = await setup();
  try {
    const pending = deferred(); h.calls.execute = 0; h.events.length = 0;
    h.setBehavior(() => pending.promise);
    const first = h.controller.readSnapshot(), second = h.controller.readSnapshot();
    assert.equal(first, second); assert.equal(h.calls.execute, 1);
    h.setBehavior(async () => snapshot(laterRoute));
    const wc = h.guests[0].webContents; wc.url = 'https://discord.com' + laterRoute; wc.emit('did-navigate-in-page', {}, wc.url, true);
    await h.controller.readSnapshot();
    pending.resolve(snapshot());
    await assert.rejects(first, /changed/);
    const published = h.events.filter(event => event.channel === 'vdc:snapshot');
    assert.equal(published.at(-1).value.route, laterRoute);
    assert.ok(!published.some(event => event.value.route === route && event.value.canSend));
  } finally { h.controller.dispose(); }
});

test('read failure disables composing and a subsequent valid read recovers without sending', async () => {
  const h = await setup();
  try {
    h.setBehavior(async () => { throw new Error('Renderer unavailable'); });
    await h.controller.poll();
    assert.equal(h.controller.getState().ready, false); assert.ok(h.controller.getState().error);
    assert.equal((await h.controller.sendMessage({ route, text: '초안' })).ok, false); assert.equal(h.calls.transport, 0);
    h.setBehavior(async () => snapshot()); await h.controller.poll();
    assert.equal(h.controller.getState().ready, true); assert.equal(h.controller.getState().error, '');
    assert.equal(h.calls.transport, 0);
  } finally { h.controller.dispose(); }
});

test('opening a conversation excludes logout, reload and concurrent operations', async () => {
  const opened = deferred();
  const h = await setup();
  try {
    h.setBehavior(async method => method === 'open' ? opened.promise : snapshot());
    const navigation = h.controller.openConversation('route:' + route);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.controller.getState().opening, true);
    assert.equal(await h.controller.action('clear-session'), false);
    assert.equal(await h.controller.action('reload'), false);
    assert.equal((await h.controller.sendMessage({ route, text: '전송 금지' })).ok, false);
    assert.equal(h.calls.dialogs, 0);
    opened.resolve({ ok: true }); assert.equal((await navigation).ok, true);
    assert.equal(h.controller.getState().opening, false);
  } finally { h.controller.dispose(); }
});

test('a pending logout confirmation is single-flight and cannot clear a closed window session', async () => {
  const answer = deferred();
  const h = await setup({ dialog: () => answer.promise });
  const first = h.controller.action('clear-session');
  assert.equal(await h.controller.action('clear-session'), false); assert.equal(h.calls.dialogs, 1);
  h.closeHost(); answer.resolve({ response: 1 });
  assert.equal(await first, false); assert.equal(h.calls.clear, 0);
});

test('logout invalidates in-flight reads before the new guest is attached', async () => {
  const storage = deferred(), read = deferred();
  const h = await setup({ clear: () => storage.promise });
  try {
    h.setBehavior(() => read.promise); const oldRead = h.controller.readSnapshot();
    const logout = h.controller.action('clear-session');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.guests[0].webContents.isDestroyed(), true);
    read.resolve(snapshot()); await assert.rejects(oldRead, /changed/);
    assert.equal(h.events.filter(event => event.channel === 'vdc:snapshot').at(-1).value.reset, true);
    storage.resolve(); assert.equal(await logout, true);
    assert.equal(h.guests.length, 2);
    assert.equal(h.controller.getState().ready, false);
  } finally { h.controller.dispose(); }
});

test('direct account changes reset cached discovery and cancel an active transmission', async () => {
  const transport = deferred(); let sendContext;
  const h = await setup({ transport: args => { sendContext = args; return transport.promise; } });
  try {
    const sending = h.controller.sendMessage({ route, text: '입력' });
    assert.equal(sendContext.isCurrent(), true);
    h.setBehavior(async () => ({ ...snapshot(), accountId: '200', channels: [] }));
    await h.controller.readSnapshot();
    assert.equal(sendContext.isCurrent(), false);
    assert.ok(h.events.some(event => event.channel === 'vdc:snapshot' && event.value.reset && event.value.accountId === '200'));
    transport.resolve({ ok: false, uncertain: true }); await sending;
    assert.equal((await h.controller.openConversation('route:' + laterRoute)).ok, false);
  } finally { h.controller.dispose(); }
});

test('window disposal cancels transmission context without releasing it into a replacement guest', async () => {
  const transport = deferred(); let sendContext;
  const h = await setup({ transport: args => { sendContext = args; return transport.promise; } });
  const sending = h.controller.sendMessage({ route, text: '입력' });
  assert.equal(sendContext.isCurrent(), true);
  h.closeHost(); assert.equal(sendContext.isCurrent(), false);
  transport.resolve({ ok: false, uncertain: true });
  assert.equal((await sending).ok, false);
  assert.equal(h.guests.length, 1);
});

test('reloading the same route invalidates the pending send document permanently', async () => {
  const transport = deferred(); let sendContext;
  const h = await setup({ transport: args => { sendContext = args; return transport.promise; } });
  try {
    const sending = h.controller.sendMessage({ route, text: '입력 중' });
    assert.equal(sendContext.isCurrent(), true);
    const wc = h.guests[0].webContents;
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    assert.equal(sendContext.isCurrent(), false);
    wc.emit('did-stop-loading'); await h.controller.readSnapshot();
    assert.equal(h.controller.getState().ready, true);
    assert.equal(sendContext.isCurrent(), false, 'same URL after reload is a different document');
    transport.resolve({ ok: false, uncertain: true }); await sending;
  } finally { h.controller.dispose(); }
});

test('an embedded frame loading does not cancel a send or disable the ready conversation', async () => {
  const transport = deferred(); let sendContext;
  const h = await setup({ transport: args => { sendContext = args; return transport.promise; } });
  try {
    const sending = h.controller.sendMessage({ route, text: '입력 중' });
    const wc = h.guests[0].webContents;
    wc.emit('did-start-loading');
    wc.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    wc.emit('did-navigate-in-page', {}, 'https://discord.com/embed', false);
    assert.equal(sendContext.isCurrent(), true);
    assert.equal(h.controller.getState().ready, true);
    assert.equal(h.controller.getState().busy, false);
    transport.resolve({ ok: true });
    assert.equal((await sending).ok, true);
  } finally { h.controller.dispose(); }
});

test('a main-frame SPA route change still cancels an active send', async () => {
  const transport = deferred(); let sendContext;
  const h = await setup({ transport: args => { sendContext = args; return transport.promise; } });
  try {
    const sending = h.controller.sendMessage({ route, text: '입력 중' });
    const wc = h.guests[0].webContents;
    wc.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    wc.url = 'https://discord.com' + laterRoute;
    h.setBehavior(async () => snapshot(laterRoute));
    wc.emit('did-navigate-in-page', {}, wc.url, true);
    assert.equal(sendContext.isCurrent(), false);
    await h.controller.readSnapshot();
    assert.equal(h.controller.getState().ready, true);
    assert.equal(sendContext.isCurrent(), false);
    transport.resolve({ ok: false, uncertain: true });
    assert.equal((await sending).ok, false);
  } finally { h.controller.dispose(); }
});

test('Windows and Mac reload shortcuts share the send gate and only reload the guest when idle', async () => {
  const transport = deferred();
  const h = await setup({ transport: () => transport.promise });
  let reloads = 0, prevented = 0;
  h.guests[0].webContents.reload = () => { reloads += 1; };
  const inputs = [
    { type: 'keyDown', key: 'F5' },
    { type: 'keyDown', key: 'r', control: true },
    { type: 'keyDown', key: 'R', meta: true, shift: true }
  ];
  try {
    const sending = h.controller.sendMessage({ route, text: '입력 중' });
    for (const input of inputs) h.controller.shortcuts({ preventDefault() { prevented += 1; } }, input);
    await flush();
    assert.equal(prevented, 3);
    assert.equal(reloads, 0);
    transport.resolve({ ok: true }); await sending; await flush();
    for (const input of inputs) {
      h.controller.shortcuts({ preventDefault() { prevented += 1; } }, input);
      await flush();
    }
    assert.equal(prevented, 6);
    assert.equal(reloads, 3);
    h.controller.shortcuts({ preventDefault() { prevented += 1; } }, { type: 'keyDown', key: 'r' });
    h.controller.shortcuts({ preventDefault() { prevented += 1; } }, { type: 'keyUp', key: 'r', meta: true });
    await flush();
    assert.equal(prevented, 6);
    assert.equal(reloads, 3);
  } finally { h.controller.dispose(); }
});

test('account change while logout confirmation is open cannot clear the new account', async () => {
  const answer = deferred();
  const h = await setup({ dialog: () => answer.promise });
  try {
    const logout = h.controller.action('clear-session');
    h.setBehavior(async () => ({ ...snapshot(), accountId: '200' }));
    await h.controller.readSnapshot();
    answer.resolve({ response: 1 });
    assert.equal(await logout, false);
    assert.equal(h.calls.clear, 0);
    assert.equal(h.guests.length, 1);
    assert.equal(h.controller.getState().ready, true);
  } finally { h.controller.dispose(); }
});

test('malformed snapshots and mismatched discovery keys cannot permit navigation or sending', async () => {
  const h = await setup();
  try {
    h.setBehavior(async () => ({ ...snapshot(), channels: [{ route: laterRoute, key: 'route:https://attacker.invalid', name: '대화' }] }));
    await h.controller.readSnapshot();
    assert.equal((await h.controller.openConversation('route:https://attacker.invalid')).ok, false);
    h.setBehavior(async () => null); await h.controller.poll();
    assert.equal(h.controller.getState().ready, false);
    assert.equal((await h.controller.sendMessage({ route, text: '확인' })).ok, false);
  } finally { h.controller.dispose(); }
});

test('unchanged active reads publish no duplicate state or bounds while a renderer state request forces delivery', async () => {
  const h = await setup();
  try {
    h.calls.execute = 0; h.calls.bounds = 0; h.events.length = 0;
    for (let index = 0; index < 20; index++) await h.controller.poll();
    assert.equal(h.calls.execute, 20, 'active snapshot reads are not slowed or skipped');
    assert.equal(h.calls.bounds, 0);
    assert.equal(h.events.filter(event => event.channel === 'vdc:state').length, 0);
    assert.equal(h.events.filter(event => event.channel === 'vdc:snapshot').length, 0);

    for (let index = 0; index < 2; index++) {
      assert.equal(await h.controller.action('state'), true);
      await flush();
    }
    assert.equal(h.events.filter(event => event.channel === 'vdc:state').length, 2);
    assert.equal(h.events.filter(event => event.channel === 'vdc:snapshot').length, 2);
    assert.equal(h.calls.bounds, 0);
  } finally { h.controller.dispose(); }
});

test('bounds are applied on size, mode and guest changes while navigation-state changes remain observable', async () => {
  const h = await setup();
  try {
    h.calls.bounds = 0; h.events.length = 0;
    h.window.contentSize = [1600, 1000];
    h.controller.layout(); h.controller.layout();
    assert.equal(h.calls.bounds, 1);
    assert.deepEqual(h.guests[0].bounds, { x: 1620, y: 76, width: 1600, height: 900 });
    await h.controller.action('toggle-mode');
    assert.equal(h.calls.bounds, 2);
    assert.deepEqual(h.guests[0].bounds, { x: 0, y: 76, width: 1600, height: 900 });
    h.guests[0].webContents.navigationHistory.canGoBack = () => true;
    await h.controller.poll();
    assert.equal(h.calls.bounds, 2);
    assert.equal(h.events.filter(event => event.channel === 'vdc:state').at(-1).value.canBack, true);
    assert.equal(await h.controller.action('clear-session'), true);
    assert.equal(h.guests.length, 2);
    assert.equal(h.calls.bounds, 3, 'a replacement guest receives its bounds even when they match its predecessor');
    assert.deepEqual(h.guests[1].bounds, { x: 0, y: 76, width: 1600, height: 900 });
  } finally { h.controller.dispose(); }
});

test('periodic scans pause while minimized or hidden and resume immediately without blocking explicit reads or navigation', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const h = await setup({ controller: { pollIntervalMs: 700 } });
  const intervals = async count => {
    for (let index = 0; index < count; index++) { context.mock.timers.tick(700); await flush(); }
  };
  try {
    h.calls.execute = 0;
    await intervals(3);
    assert.equal(h.calls.execute, 3, 'visible window keeps its 700ms polling cadence');
    h.calls.execute = 0;
    h.window.minimized = true;
    await intervals(5);
    assert.equal(h.calls.execute, 0);
    assert.equal(h.guests[0].webContents.isDestroyed(), false);
    await h.controller.readSnapshot();
    assert.equal(h.calls.execute, 1, 'explicit reads remain available while minimized');
    h.window.minimized = false; h.window.visible = false; h.calls.execute = 0;
    await intervals(5);
    assert.equal(h.calls.execute, 0);
    assert.equal((await h.controller.openConversation('route:' + route)).ok, true);
    assert.equal(h.calls.execute, 3, 'navigation still performs its two forced snapshots and open action');
    h.calls.execute = 0; h.window.visible = true;
    h.window.emit('show'); await flush();
    assert.equal(h.calls.execute, 1, 'show does not wait for the next timer interval');
    h.calls.execute = 0;
    h.window.emit('restore'); await flush();
    assert.equal(h.calls.execute, 1, 'restore does not wait for the next timer interval');
    assert.equal(h.window.listenerCount('show'), 1);
    assert.equal(h.window.listenerCount('restore'), 1);
    h.controller.start();
    assert.equal(h.window.listenerCount('show'), 1, 'repeated start does not duplicate listeners');
    h.controller.dispose();
    assert.equal(h.window.listenerCount('show'), 0);
    assert.equal(h.window.listenerCount('restore'), 0);
    h.calls.execute = 0;
    h.window.emit('show'); h.window.emit('restore'); await intervals(2);
    assert.equal(h.calls.execute, 0);
  } finally { h.controller.dispose(); }
});
