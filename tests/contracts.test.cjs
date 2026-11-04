'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSnapshot, isSendRequest } = require('../src/shared/contracts');

test('snapshot normalization derives routing keys and rejects untrusted active state', () => {
  const value = normalizeSnapshot({ loggedIn: true, route: '/channels/@me/123', accountId: '1234', canSend: true, routeReady: false,
    channels: [{ route: '/channels/@me/123', key: 'arbitrary', name: '친구' }, { route: 'javascript:alert(1)', name: '잘못된 주소' }],
    rows: [{ id: '1', text: '오래된 대화' }], guilds: [{ id: '5', key: 'arbitrary', name: '서버' }] });
  assert.equal(value.channels.length, 1); assert.equal(value.channels[0].key, 'route:/channels/@me/123');
  assert.equal(value.guilds[0].key, 'guild:5'); assert.equal(value.canSend, false); assert.deepEqual(value.rows, []);
  assert.equal(value.accountId, '1234');
  assert.throws(() => normalizeSnapshot(null), /Invalid/);
});

test('send contract accepts unchanged multiline strings but rejects malformed or oversized requests', () => {
  const route = '/channels/@me/123';
  assert.equal(isSendRequest({ route, text: '  첫 줄\n"두 번째"  ' }), true);
  for (const text of ['', '   ', null, {}, 'a'.repeat(2001)]) assert.equal(isSendRequest({ route, text }), false);
  assert.equal(isSendRequest({ route: '/channels/@me', text: '내용' }), false);
});
