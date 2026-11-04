'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapterClient } = require('../src/main/adapter-client');
const { registerBridge } = require('../src/main/ipc');
const { isDiscordURL } = require('../navigation');
const vm = require('node:vm');

test('adapter source is sent once per document and a cleared world reinstalls without repeating mutations', async () => {
  const scripts = [];
  const context = vm.createContext({ window: {}, Date });
  const source = 'window.__vdcAdapter = { snapshot: () => ({route:"/channels/@me/123"}), open: () => { window.opens = (window.opens || 0) + 1; return { ok:true }; } };' + ' '.repeat(10000);
  const invoke = createAdapterClient({ source, isDiscordURL });
  const wc = { isDestroyed: () => false, getURL: () => 'https://discord.com/channels/@me/123',
    executeJavaScriptInIsolatedWorld: async (_world, entries) => { scripts.push(entries[0].code); return vm.runInContext(entries[0].code, context); } };
  await invoke(wc, 'snapshot');
  for (let i = 0; i < 3; i++) await invoke(wc, 'snapshot');
  assert.ok(scripts[0].length > 10000);
  assert.ok(scripts.slice(1).every(code => code.length < 500));
  delete context.window.__vdcAdapter;
  await invoke(wc, 'open', ['route:/channels/@me/123']);
  assert.equal(context.window.opens, 1);
  assert.equal(scripts.length, 6, 'missing-adapter probe plus a single installation/action');
  assert.ok(scripts.at(-1).length > 10000);
  await invoke(wc, 'open', ['route:/channels/@me/123']);
  assert.equal(context.window.opens, 2);
  assert.ok(scripts.at(-1).length < 500);
});

test('a missing-adapter probe cannot reinstall or mutate after the document becomes stale', async () => {
  let calls = 0, current = true;
  const invoke = createAdapterClient({ source: '', isDiscordURL });
  const wc = { isDestroyed: () => false, getURL: () => 'https://discord.com/channels/@me/123',
    executeJavaScriptInIsolatedWorld: async () => { calls++; if (calls === 1) return { ok: true }; current = false; return { __vdcAdapterMissing: true }; } };
  await invoke(wc, 'snapshot');
  await assert.rejects(invoke(wc, 'open', [], () => current), /changed/);
  assert.equal(calls, 2);
});

test('adapter calls expire and queued mutations include an in-document deadline', async () => {
  let code;
  const invoke = createAdapterClient({ source: '', isDiscordURL, timeoutMs: 10 });
  const wc = { isDestroyed: () => false, getURL: () => 'https://discord.com/channels/@me/123', executeJavaScriptInIsolatedWorld: (_id, scripts) => {
    code = scripts[0].code; return new Promise(() => {});
  } };
  await assert.rejects(invoke(wc, 'open', ['route:/channels/@me/123']), /timed out/);
  assert.match(code, /Date\.now\(\) > \d+/);
  await assert.rejects(invoke(wc, 'unsupported'), /Unsupported/);
});

test('IPC accepts only the current local main frame and removes handlers on disposal', async () => {
  const handlers = new Map(), calls = [];
  const frame = { url: 'file:///trusted/live.html' }, wc = { mainFrame: frame };
  const cleanup = registerBridge({ ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    window: { isDestroyed: () => false, webContents: wc }, isLocalPage: url => url === frame.url,
    controller: { action: async value => { calls.push(value); return true; } } });
  const act = handlers.get('vdc:action');
  await assert.rejects(act({ sender: {}, senderFrame: frame }, 'close'), /Untrusted/);
  await assert.rejects(act({ sender: wc, senderFrame: { url: frame.url } }, 'close'), /Untrusted/);
  assert.equal(await act({ sender: wc, senderFrame: frame }, 'state'), true);
  assert.deepEqual(calls, ['state']); cleanup(); assert.equal(handlers.size, 0);
});
