'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const storageKey = 'vdc.file-names.v1';
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/file-names.js'), 'utf8');

function createProvider(storage) {
  const window = { VDCUI: {} };
  vm.runInNewContext(source, { window });
  return window.VDCUI.createFileNames(storage);
}

test('file aliases and their enabled preference survive reload without storing names or colliding beyond the initial pool', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value)
  };
  const records = Array.from({ length: 60 }, (_, index) => ({
    route: '/channels/@me/' + (1000 + index),
    name: 'private-display-name-' + index,
    text: 'private-message-content-' + index
  }));
  const first = createProvider(storage);
  first.assign(records.slice().reverse());
  assert.equal(first.enabled, false);
  assert.equal(first.filename(records[0]), records[0].name + '.tsx');
  first.toggle();
  const aliases = records.map(record => first.filename(record));
  assert.equal(new Set(aliases).size, records.length);
  assert.ok(aliases.every(alias => /\.(?:jsx|tsx)$/.test(alias)));

  const reloaded = createProvider(storage);
  assert.equal(reloaded.enabled, true);
  const additional = { route: '/channels/@me/9999', name: 'another-private-name' };
  reloaded.assign([additional, ...records.slice().reverse().map(record => ({ ...record, name: 'renamed-private-name' }))]);
  assert.deepEqual(records.map(record => reloaded.filename(record)), aliases);
  assert.ok(!aliases.includes(reloaded.filename(additional)));

  const saved = JSON.parse(values.get(storageKey));
  assert.deepEqual(Object.keys(saved).sort(), ['aliases', 'enabled']);
  assert.equal(Object.keys(saved.aliases).length, records.length + 1);
  assert.ok(!values.get(storageKey).includes('private-'));
  assert.deepEqual(Object.keys(saved.aliases).sort(), [...records.map(record => record.route), additional.route].sort());
  assert.equal(reloaded.toggle(), false);
  assert.equal(createProvider(storage).enabled, false);
});

test('corrupt or unavailable preference storage leaves filename mode usable in memory', () => {
  const record = { route: '/channels/@me/123', name: 'friend' };
  const blocked = {
    getItem() { throw new Error('Storage unavailable'); },
    setItem() { throw new Error('Storage unavailable'); }
  };
  const corrupt = { getItem: () => '{bad json', setItem() {} };
  for (const storage of [blocked, corrupt, null]) {
    const provider = createProvider(storage);
    assert.equal(provider.enabled, false);
    assert.equal(provider.filename(record), 'friend.tsx');
    provider.assign([record]);
    assert.equal(provider.toggle(), true);
    const alias = provider.filename(record);
    assert.match(alias, /\.(?:jsx|tsx)$/);
    assert.notEqual(alias, 'friend.tsx');
    provider.assign([{ ...record, name: 'renamed friend' }]);
    assert.equal(provider.filename(record), alias);
    assert.equal(provider.toggle(), false);
    assert.equal(provider.filename(record), 'friend.tsx');
  }
});
