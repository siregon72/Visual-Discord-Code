'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { transmitMessage } = require('../send-message');
const route = '/channels/@me/123';
const text = '새 메시지';
const base = () => ({ route, canSend: true, routeReady: true, hasDialog: false, draftText: '' });
function harness({ before = base(), inserted = { ok: true, focused: true, text, route }, ready = { ok: true, route },
  empty = { ok: true, focused: true, text: '', route }, onInsert = () => {},
  submit = { ok: true, dispatched: true }, onSubmit = () => {} } = {}) {
  let reads = 0, states = 0;
  const inserts = [], submissions = [], nativeEvents = [];
  return {
    inserts, submissions, nativeEvents, get reads() { return reads; },
    run: (overrides = {}) => {
      const { callAdapter: overrideAdapter, ...options } = overrides;
      return transmitMessage({ request: { route, text }, wc: {
        insertText: async value => { inserts.push(value); await onInsert(); },
        sendInputEvent: event => nativeEvents.push(event)
      },
      readSnapshot: async () => {
        if (++reads > 1) throw new Error('post-send reads are not allowed');
        return before;
      },
      callAdapter: async (method, ...args) => {
        if (method === 'submitComposer') { submissions.push(args); await onSubmit(); return submit; }
        if (overrideAdapter) return overrideAdapter(method, ...args);
        return method === 'focusComposer' ? ready : states++ === 0 ? empty : inserted;
      },
      focus: () => {}, wait: async () => {}, ...options });
    }
  };
}

test('a guarded dispatch returns immediately without reading messages or waiting for the native draft to clear', async () => {
  const waits = [], before = base();
  Object.defineProperty(before, 'rows', { get() { throw new Error('message results must not be inspected'); } });
  const h = harness({ before, onSubmit: () => { before.draftText = text; } });
  const result = await h.run({ wait: async ms => waits.push(ms) });
  assert.deepEqual(result, { ok: true, submitted: true });
  assert.equal(before.draftText, text, 'handoff does not require the native draft to clear');
  assert.equal(h.reads, 1, 'only the pre-send snapshot is read');
  assert.deepEqual(waits, []);
  assert.deepEqual(h.inserts, [text]);
  assert.deepEqual(h.submissions, [[route, text]]);
  assert.deepEqual(h.nativeEvents, []);
});

test('mismatched recipients, native drafts, dialogs and unavailable composers prevent insertion', async () => {
  for (const change of [{ route: '/channels/@me/456' }, { draftText: 'native draft' },
    { canSend: false }, { canSend: undefined }, { routeReady: false }, { hasDialog: true }]) {
    const h = harness({ before: { ...base(), ...change } });
    assert.equal((await h.run()).ok, false, JSON.stringify(change));
    assert.equal(h.inserts.length, 0);
    assert.equal(h.submissions.length, 0);
  }
  const existing = harness({ ready: { ok: false, error: 'native draft' } });
  assert.equal((await existing.run()).ok, false);
  assert.equal(existing.inserts.length, 0);
});

test('route or focus changes after insertion prevent Enter and preserve uncertainty', async () => {
  for (const inserted of [{ ok: false, focused: true, text, route },
    { ok: true, focused: false, text, route }, { ok: true, focused: true, text, route: '/channels/@me/456' }]) {
    const h = harness({ inserted }), result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.equal(result.submitted, false);
    assert.equal(h.inserts.length, 1);
    assert.equal(h.submissions.length, 0);
  }
});

test('insertion preserves exact whitespace, Unicode and message formatting', async () => {
  for (const raw of ['  새 메시지\n', '**굵게** 그리고 `const x = 1;`', '한글\n둘째 줄 👋']) {
    const h = harness({ inserted: { ok: true, focused: true, text: raw, route } });
    assert.equal((await h.run({ request: { route, text: raw } })).ok, true);
    assert.deepEqual(h.inserts, [raw]);
    assert.deepEqual(h.submissions, [[route, raw]]);
  }
});

test('lifecycle cancellation before insertion cannot type and cancellation during insertion cannot dispatch', async () => {
  const before = harness();
  assert.equal((await before.run({ isCurrent: () => false })).ok, false);
  assert.equal(before.inserts.length, 0);
  assert.equal(before.submissions.length, 0);
  let active = true;
  const during = harness({ onInsert: () => { active = false; } });
  const result = await during.run({ isCurrent: () => active });
  assert.equal(result.uncertain, true);
  assert.equal(during.inserts.length, 1);
  assert.equal(during.submissions.length, 0);
});

test('lifecycle cancellation during dispatch cannot acknowledge a new session or retry', async () => {
  let active = true;
  const h = harness({ onSubmit: () => { active = false; } });
  const result = await h.run({ isCurrent: () => active });
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.submitted, true);
  assert.equal(h.submissions.length, 1);
  assert.equal(h.reads, 1);
});

test('deadline expiry after insertion leaves the native draft and never dispatches', async () => {
  let clock = 0;
  const h = harness({ inserted: { ok: true, focused: true, text: '', route } });
  const result = await h.run({ now: () => clock, timeoutMs: 50, wait: async ms => { clock += ms; } });
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(h.inserts.length, 1);
  assert.equal(h.submissions.length, 0);
});

test('a briefly incomplete insertion settles without inserting or sending twice', async () => {
  const waits = [], order = [];
  let states = 0;
  const h = harness();
  const result = await h.run({
    focus: () => order.push('native-focus'),
    callAdapter: async method => {
      order.push(method);
      if (method === 'focusComposer') return { ok: true, route };
      return { ok: true, focused: true, route, text: ['', '', '새', text][Math.min(states++, 3)] };
    },
    wait: async ms => waits.push(ms)
  });
  assert.equal(result.ok, true);
  assert.deepEqual(order.slice(0, 2), ['focusComposer', 'native-focus']);
  assert.deepEqual(waits, [20, 20]);
  assert.deepEqual(h.inserts, [text]);
  assert.equal(h.submissions.length, 1);
});

test('send-specific preflight avoids a full sidebar snapshot and is never read again after dispatch', async () => {
  let reads = 0;
  const h = harness();
  const result = await h.run({
    readSnapshot: async () => { throw new Error('full snapshot is unnecessary'); },
    readSendSnapshot: async () => {
      assert.equal(++reads, 1);
      return base();
    },
    wait: async () => { throw new Error('a ready composer needs no delay'); }
  });
  assert.deepEqual(result, { ok: true, submitted: true });
  assert.equal(reads, 1);
});

test('native focus settling is checked before Enter without a fixed delay on focused sends', async () => {
  const waits = [];
  let focused = false;
  const h = harness();
  const result = await h.run({ isFocused: () => focused, wait: async ms => { waits.push(ms); focused = true; } });
  assert.equal(result.ok, true);
  assert.deepEqual(waits, [20]);
  assert.deepEqual(h.inserts, [text]);
  assert.equal(h.submissions.length, 1);
});

test('losing native window focus leaves the draft without emitting Enter', async () => {
  const waits = [], h = harness();
  const result = await h.run({ isFocused: () => false, wait: async ms => waits.push(ms) });
  assert.equal(result.uncertain, true);
  assert.equal(result.submitted, false);
  assert.match(result.error, /전송하지 않았습니다/);
  assert.deepEqual(h.inserts, [text]);
  assert.equal(h.submissions.length, 0);
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 120);
});

test('native focus flags cannot bypass renderer document focus', async () => {
  for (const recovers of [true, false]) {
    const waits = [];
    let documentFocused = false, states = 0;
    const h = harness();
    const result = await h.run({
      isFocused: () => true,
      callAdapter: async method => method === 'focusComposer' ? { ok: true, route } :
        { ok: true, focused: true, documentFocused, route, text: states++ === 0 ? '' : text },
      wait: async ms => { waits.push(ms); if (recovers) documentFocused = true; }
    });
    assert.equal(result.ok, recovers);
    assert.deepEqual(h.inserts, [text]);
    assert.equal(h.submissions.length, recovers ? 1 : 0);
    assert.equal(waits.reduce((sum, ms) => sum + ms, 0), recovers ? 20 : 120);
    if (!recovers) assert.equal(result.submitted, false);
  }
});

test('adapter rejection before dispatch preserves the draft without reporting submission', async () => {
  const h = harness({ submit: { ok: false, dispatched: false, error: 'editor changed before dispatch' } });
  const result = await h.run();
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.submitted, false);
  assert.equal(result.error, 'editor changed before dispatch');
  assert.deepEqual(h.submissions, [[route, text]]);
  assert.deepEqual(h.nativeEvents, []);
});

test('partial dispatch and bridge failures report an error without polling, fallback or resend', async () => {
  for (const options of [
    { submit: { ok: false, dispatched: true, error: 'keyup failed after keydown' } },
    { onSubmit: () => { throw new Error('bridge disconnected after delivery'); } },
    { submit: null }, { submit: { ok: true } }
  ]) {
    const h = harness(options), result = await h.run();
    assert.equal(result.ok, false);
    assert.equal(result.uncertain, true);
    assert.equal(result.submitted, true);
    assert.equal(result.receipt, undefined);
    assert.equal(result.pending, undefined);
    assert.equal(h.reads, 1);
    assert.deepEqual(h.submissions, [[route, text]]);
    assert.deepEqual(h.nativeEvents, []);
  }
});

test('read and insertion failures report whether text could have reached Discord', async () => {
  const before = harness();
  const unreadable = await before.run({ readSnapshot: async () => { throw new Error('guest gone'); } });
  assert.equal(unreadable.ok, false);
  assert.notEqual(unreadable.uncertain, true);
  assert.equal(before.inserts.length, 0);
  const during = harness({ onInsert: () => { throw new Error('insert outcome unknown'); } });
  const uncertain = await during.run();
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.uncertain, true);
  assert.equal(uncertain.submitted, false);
  assert.equal(during.submissions.length, 0);
});

test('unvalidated requests cannot initiate mutation', async () => {
  for (const request of [null, { route, text: '' }, { route: '/channels/@me', text }, { route, text: 'x'.repeat(2001) }]) {
    const h = harness();
    assert.equal((await h.run({ request })).ok, false);
    assert.equal(h.inserts.length, 0);
    assert.equal(h.submissions.length, 0);
  }
});

test('missing or mismatched composer route evidence cannot initiate insertion', async () => {
  for (const empty of [{ ok: true, focused: true, text: '' }, { ok: true, focused: true, text: '', route: '/channels/@me/456' }]) {
    const h = harness({ empty });
    assert.equal((await h.run()).ok, false);
    assert.equal(h.inserts.length, 0);
  }
});
