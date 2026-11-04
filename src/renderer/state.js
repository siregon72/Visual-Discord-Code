'use strict';
(() => {
  const CHAT_ROUTE = /^\/channels\/(?:@me|\d+)\/\d+$/;
  const CHANNEL_ROUTE = /^\/channels\/(?:@me|\d+)(?:\/\d+)?$/;
  const AUTH_ROUTE = /^\/(?:login|register)(?:\/|\?|$)/;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' ? value : '';
  const list = value => Array.isArray(value) ? value : [];
  const emptySnapshot = () => ({ loggedIn: false, route: '', title: '', guildName: '', guilds: [], channels: [], rows: [], canSend: false, hasDialog: false, draftText: '' });

  function unique(items, key) {
    return [...new Map(items.map(item => [item[key], item])).values()];
  }

  function normalizeSnapshot(value) {
    if (!record(value)) return null;
    const route = text(value.route);
    const loggedIn = value.loggedIn === true && CHANNEL_ROUTE.test(route);
    const rows = unique(list(value.rows).filter(record).filter(item => text(item.id)).map(item => ({
      id: item.id, text: text(item.text), author: text(item.author), time: text(item.time),
      own: item.own === true, pending: item.pending === true, failed: item.failed === true,
      media: list(item.media).filter(record).map(media => ({ name: text(media.name), url: text(media.url), type: text(media.type) }))
    })), 'id');
    const channels = unique(list(value.channels).filter(record)
      .filter(item => CHAT_ROUTE.test(text(item.route)) && item.key === 'route:' + item.route && text(item.name))
      .map(item => ({ id: item.route.split('/')[3], key: item.key, route: item.route, name: item.name,
        group: text(item.group), kind: item.route.split('/')[2] === '@me' ? 'dm' : 'channel' })), 'route');
    const guilds = unique(list(value.guilds).filter(record)
      .filter(item => /^(?:\d+|home|@me)$/.test(text(item.id)) && item.key === 'guild:' + item.id)
      .map(item => ({ id: item.id, key: item.key, name: text(item.name) || '서버' })), 'id');
    return {
      loggedIn, route, title: text(value.title), guildName: text(value.guildName),
      guilds: loggedIn ? guilds : [], channels: loggedIn ? channels : [],
      rows: loggedIn && CHAT_ROUTE.test(route) && value.routeReady !== false ? rows : [],
      canSend: loggedIn && CHAT_ROUTE.test(route) && value.canSend === true && value.routeReady !== false,
      hasDialog: value.hasDialog === true, draftText: text(value.draftText), reset: value.reset === true,
      routeReady: value.routeReady !== false
    };
  }

  const fingerprint = message => JSON.stringify([message.text, message.media.map(item => [item.name, item.type])]);

  function trackVisit(visit, snapshot, liveIds) {
    if (!visit || !snapshot.loggedIn || !snapshot.routeReady) return;
    if (!visit.ready) {
      // A route can arrive before its messages. An empty, unavailable composer is
      // still loading; an empty usable conversation is a valid baseline.
      if (!snapshot.rows.length && !snapshot.canSend) return;
      visit.ready = true;
      for (const message of snapshot.rows) visit.seen.add(message.id);
      return;
    }
    const currentIds = new Set(snapshot.rows.map(message => message.id));
    let lastAnchor = -1;
    snapshot.rows.forEach((message, index) => { if (visit.seen.has(message.id)) lastAnchor = index; });
    snapshot.rows.forEach((message, index) => {
      if (visit.seen.has(message.id)) return;
      const time = Date.parse(message.time);
      let replacement;
      if (message.own && !message.pending) {
        const key = fingerprint(message);
        replacement = [...visit.pending].find(([id, pending]) => !currentIds.has(id) && pending.key === key &&
          (Number.isFinite(time) && Number.isFinite(pending.time) ? Math.abs(time - pending.time) <= 10000 : index > lastAnchor));
      }
      // Wall time distinguishes newly received messages from pre-existing rows
      // revealed by Discord's virtualized history, including newer history pages.
      // Without a timestamp, only a clear append to a known window is considered new.
      const fresh = replacement || (Number.isFinite(time) ? time >= visit.startedAt :
        (lastAnchor >= 0 ? index > lastAnchor : visit.seen.size === 0));
      if (fresh) liveIds.add(message.id);
      if (replacement) visit.pending.delete(replacement[0]);
    });
    for (const message of snapshot.rows) {
      visit.seen.add(message.id);
      if (!message.pending) visit.pending.delete(message.id);
      else if (liveIds.has(message.id) && message.own) visit.pending.set(message.id, { key: fingerprint(message), time: Date.parse(message.time) });
    }
    while (visit.pending.size > 32) visit.pending.delete(visit.pending.keys().next().value);
  }

  function createModel() {
    const model = {
      snapshot: emptySnapshot(),
      connection: { mode: 'code', connected: false, busy: true, error: '', loginRequired: true, sending: false, opening: false, clearing: false },
      channels: new Map(), guilds: new Map(), drafts: new Map(), draftVersions: new Map(), uncertainties: new Set(), epoch: 0,
      visit: null, liveMessageIds: new Set(),
      saveDraft(route, value) {
        if (!CHAT_ROUTE.test(route)) return;
        if ((this.drafts.get(route) || '') !== value) this.draftVersions.set(route, (this.draftVersions.get(route) || 0) + 1);
        if (value) this.drafts.set(route, value);
        else this.drafts.delete(route);
      },
      receiveSnapshot(value, currentDraft) {
        const next = normalizeSnapshot(value);
        if (!next) return null;
        const previous = this.snapshot;
        const reset = next.reset || AUTH_ROUTE.test(next.route);
        if (reset) {
          this.epoch++;
          this.channels.clear(); this.guilds.clear(); this.drafts.clear(); this.draftVersions.clear(); this.uncertainties.clear();
          currentDraft = '';
          if (!next.loggedIn || AUTH_ROUTE.test(next.route)) {
            next.title = ''; next.guildName = ''; next.rows = []; next.channels = []; next.guilds = [];
          }
        } else if (!next.loggedIn && (!next.route || next.route === previous.route)) {
          // A navigation/read gap is not an account reset. Keep the current document
          // and draft visible while all send controls remain unavailable.
          next.route = previous.route;
          next.title = previous.title;
          next.guildName = previous.guildName;
          next.rows = previous.rows;
        }
        const routeChanged = next.route !== previous.route;
        if (routeChanged && !reset) this.saveDraft(previous.route, currentDraft);
        if (routeChanged || reset) {
          this.liveMessageIds.clear();
          this.visit = CHAT_ROUTE.test(next.route) ? { startedAt: Date.now(), ready: false, seen: new Set(), pending: new Map() } : null;
        }
        trackVisit(this.visit, next, this.liveMessageIds);
        this.snapshot = next;
        for (const channel of next.channels) this.channels.set(channel.route, channel);
        for (const guild of next.guilds) if (!['home', '@me'].includes(guild.id)) this.guilds.set(guild.id, guild);
        return { routeChanged, reset, draft: reset ? '' : routeChanged ? this.drafts.get(next.route) || '' : currentDraft };
      },
      receiveState(value) {
        if (!record(value)) return false;
        const next = { ...this.connection };
        for (const key of ['connected', 'busy', 'loginRequired', 'sending', 'opening', 'clearing', 'ready']) {
          if (typeof value[key] === 'boolean') next[key] = value[key];
        }
        if (value.mode === 'code' || value.mode === 'native') next.mode = value.mode;
        if (typeof value.error === 'string') next.error = value.error;
        this.connection = next;
        return true;
      },
      canReadHistory({ manualHelp = false, sending = false, opening = false } = {}) {
        const snap = this.snapshot, state = this.connection;
        return snap.loggedIn && CHAT_ROUTE.test(snap.route) && snap.routeReady !== false && !snap.hasDialog &&
          state.mode === 'code' && state.ready !== false && !state.busy && !state.error &&
          !state.sending && !state.opening && !state.clearing && !manualHelp && !sending && !opening;
      },
      canCompose(options = {}) {
        const snap = this.snapshot;
        return this.canReadHistory(options) && snap.canSend && !snap.draftText && !this.uncertainties.has(snap.route);
      }
    };
    return model;
  }
  window.VDCUI.createModel = createModel;
  window.VDCUI.normalizeSnapshot = normalizeSnapshot;
})();
