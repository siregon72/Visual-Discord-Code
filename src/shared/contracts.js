'use strict';

const CHAT_ROUTE = /^\/channels\/(?:@me|\d+)\/\d+$/;
const CHANNEL_ROUTE = /^\/channels\/(?:@me|\d+)(?:\/\d+)?$/;
const AUTH_ROUTE = /^\/(?:login|register)(?:\/|$)/;
const ACTIONS = new Set(['connect', 'toggle-mode', 'home', 'reload', 'back', 'forward', 'minimize', 'maximize', 'close', 'clear-session', 'state']);
const IPC = Object.freeze({ action: 'vdc:action', open: 'vdc:open', send: 'vdc:send', history: 'vdc:history', state: 'vdc:state', snapshot: 'vdc:snapshot' });

const text = (value, max = 10000) => typeof value === 'string' ? value.slice(0, max) : '';
const list = (value, max) => Array.isArray(value) ? value.slice(0, max) : [];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function emptySnapshot(reset = false) {
  return { loggedIn: false, route: '', accountId: '', title: '', guildName: '', guilds: [], channels: [], rows: [], canSend: false, hasDialog: false, draftText: '', routeReady: false, reset };
}

function normalizeSnapshot(value) {
  if (!record(value) || typeof value.route !== 'string' || typeof value.loggedIn !== 'boolean') throw new Error('Invalid Discord snapshot');
  const route = text(value.route, 160);
  const loggedIn = value.loggedIn && CHANNEL_ROUTE.test(route);
  const hasDialog = value.hasDialog === true;
  const routeReady = value.routeReady !== false;
  const channels = loggedIn ? list(value.channels, 10000).filter(item => record(item) && CHAT_ROUTE.test(item.route) && typeof item.name === 'string').map(item => ({
    id: item.route.split('/')[3], key: 'route:' + item.route, route: item.route,
    name: text(item.name, 300), group: text(item.group, 300), kind: item.route.split('/')[2] === '@me' ? 'dm' : 'channel'
  })) : [];
  const guilds = loggedIn ? list(value.guilds, 2000).filter(item => record(item) && /^(?:\d+|home|@me)$/.test(String(item.id))).map(item => ({
    id: String(item.id), key: 'guild:' + String(item.id), name: text(item.name, 300)
  })) : [];
  const rows = loggedIn && CHAT_ROUTE.test(route) && routeReady ? list(value.rows, 2000).filter(item => record(item) && typeof item.id === 'string' && item.id).map(item => ({
    id: text(item.id, 200), author: text(item.author, 300), text: text(item.text, 100000), time: text(item.time, 200),
    own: item.own === true, pending: item.pending === true, failed: item.failed === true,
    media: list(item.media, 12).filter(record).map(media => ({ name: text(media.name, 1000), type: text(media.type, 50), url: text(media.url, 10000) }))
  })) : [];
  return { loggedIn, route, accountId: /^\d+$/.test(value.accountId) ? text(value.accountId, 40) : '', title: text(value.title, 300), guildName: text(value.guildName, 300), guilds, channels, rows,
    canSend: loggedIn && CHAT_ROUTE.test(route) && routeReady && !hasDialog && value.canSend === true,
    hasDialog, draftText: text(value.draftText, 100000), routeReady, reset: false };
}

function isSendRequest(value) {
  return record(value) && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 2000 && typeof value.route === 'string' && CHAT_ROUTE.test(value.route);
}

function isHistoryRequest(value) {
  return record(value) && [-1, 1].includes(value.direction) && typeof value.route === 'string' && CHAT_ROUTE.test(value.route);
}

module.exports = { ACTIONS, IPC, CHAT_ROUTE, CHANNEL_ROUTE, AUTH_ROUTE, emptySnapshot, normalizeSnapshot, isSendRequest, isHistoryRequest };
