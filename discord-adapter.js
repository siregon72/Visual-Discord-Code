/* Read only the rendered Discord UI. This adapter never accesses tokens,
 * internal stores or APIs. User-triggered UI navigation and composer focus
 * are its only mutations; the host owns deliberate, manual message sends. */
(() => {
  'use strict';
  const ROW = 'li[id^="chat-messages-"], [data-list-item-id^="chat-messages___"]';
  const COMPOSER = '[role="textbox"][contenteditable="true"][data-slate-editor="true"], [role="textbox"][contenteditable="true"][class*="slateTextArea"]';
  const CHANNEL_ROUTE = /^\/channels\/(?:@me|\d+)(?:\/\d+)?$/;
  const CHAT_ROUTE = /^\/channels\/(?:@me|\d+)\/\d+$/;
  const clean = value => String(value || '').replace(/[\u200b\uFEFF]/g, '').trim();
  const nodes = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  // The snapshot is synchronous: reuse layout reads only until it returns. Never
  // retain DOM answers across polling ticks or across a focus/navigation mutation.
  let readContext = null;
  function hidden(element) {
    if (!element?.isConnected) return true;
    // A visible-looking child in an unmounted/hidden Discord panel is not a live
    // composer. Checking only the element's own style misses hidden ancestors.
    const cache = readContext?.visibility;
    const visited = [];
    let result = false;
    for (let current = element; current; current = current.parentElement) {
      if (cache?.has(current)) { result = cache.get(current); break; }
      visited.push(current);
      if (current.hasAttribute('hidden') || current.hasAttribute('inert') || current.getAttribute('aria-hidden') === 'true') { result = true; break; }
      const style = getComputedStyle(current);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) { result = true; break; }
    }
    if (cache) for (const current of visited) cache.set(current, result);
    return result;
  }
  const route = () => location.pathname.replace(/\/$/, '');
  const dialogs = () => nodes('[role="dialog"], [role="alertdialog"]').filter(el => !hidden(el));

  function textOf(element, { exclude = '', multiline = false } = {}) {
    if (!element) return '';
    // Plain message/author/channel text needs no detached subtree or selectors.
    if (element.childElementCount === 0) return clean(element.textContent);
    const copy = element.cloneNode(true);
    if (exclude) nodes(exclude, copy).forEach(el => el.remove());
    nodes('img[alt]', copy).forEach(el => el.replaceWith(document.createTextNode(el.getAttribute('alt'))));
    if (multiline) {
      nodes('br', copy).forEach(el => el.replaceWith(document.createTextNode('\n')));
      nodes('p, div, pre', copy).forEach(el => el.append(document.createTextNode('\n')));
    }
    return clean(copy.textContent);
  }

  function getComposer() {
    const candidates = nodes(COMPOSER).filter(el => !hidden(el) &&
      !el.closest('[aria-disabled="true"]') &&
      !el.closest(`${ROW}, [role="dialog"], [role="alertdialog"]`));
    // Never guess which editor is active while Discord is transitioning panels.
    return candidates.length === 1 ? candidates[0] : null;
  }

  function draftText(element = getComposer()) {
    return textOf(element, { exclude: '[data-slate-placeholder], [aria-hidden="true"]', multiline: true });
  }

  function channelName(link) {
    const name = link.querySelector('[class*="name_"] [class*="overflow_"], [class*="name_"], [class*="channelName_"], [class*="overflow_"]');
    return textOf(name || link, { exclude: '[class*="badge"], [class*="Badge"], [class*="clan"], [class*="Clan"], [class*="subText"], [class*="activity"], [class*="Activity"], [class*="status"], [class*="Status"], [class*="icon"], [class*="Icon"], svg, button, [aria-hidden="true"]' }).split('\n')[0] || clean(link.getAttribute('aria-label'));
  }

  function rowElements() {
    if (readContext?.rows) return readContext.rows;
    const seen = new Set();
    const rows = nodes(ROW).filter(element => {
      if (hidden(element) || element.parentElement?.closest(ROW)) return false;
      const key = element.id || element.getAttribute('data-list-item-id');
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    });
    if (readContext) readContext.rows = rows;
    return rows;
  }

  function messageChannelId(row) {
    return (row.id || '').match(/^chat-messages-(\d+)-\d+$/)?.[1] || '';
  }

  function routeReady() {
    const channelId = route().split('/')[3];
    if (!channelId) return true;
    const renderedChannels = rowElements().map(messageChannelId).filter(Boolean);
    // Discord may commit a route before React replaces the previous room's DOM.
    // Empty or unidentifiable lists remain valid, including newly created chats.
    return renderedChannels.length === 0 || renderedChannels.every(id => id === channelId);
  }

  function guildElements() {
    const found = new Map();
    for (const element of nodes('[data-list-item-id^="guildsnav___"]')) {
      if (hidden(element)) continue;
      const id = element.getAttribute('data-list-item-id').slice('guildsnav___'.length);
      if (!/^\d+$/.test(id) && !['home', '@me'].includes(id)) continue;
      const target = element.matches('a, [role="treeitem"], [role="button"]') ? element : element.querySelector('a, [role="treeitem"], [role="button"]') || element;
      const name = clean(target.getAttribute('aria-label') || element.getAttribute('aria-label') || target.getAttribute('data-dnd-name') || element.closest('[data-dnd-name]')?.getAttribute('data-dnd-name') || clean(element.querySelector('img')?.getAttribute('alt')) || textOf(element)).replace(/^\d+\s*,\s*/, '');
      found.set(id, { element: target, id, key: 'guild:' + id, name: ['home', '@me'].includes(id) ? 'direct' : name || '서버 ' + id });
    }
    // Some Discord layouts use normal anchors in the guild rail.
    for (const link of nodes('nav[class*="guilds"] a[href^="/channels/"], [class*="guilds_"] a[href^="/channels/"]')) {
      if (hidden(link)) continue;
      const parts = (link.getAttribute('href') || '').split('/').filter(Boolean);
      const id = parts[1] === '@me' ? 'home' : parts[1];
      if ((!/^\d+$/.test(id) && id !== 'home') || found.has(id)) continue;
      found.set(id, { element: link, id, key: 'guild:' + id, name: id === 'home' ? 'direct' : clean(link.getAttribute('aria-label') || link.querySelector('img')?.alt || link.textContent) || '서버 ' + id });
    }
    return [...found.values()];
  }

  function channelElements() {
    const found = new Map();
    // A long category otherwise rescans the same preceding siblings for every
    // channel on every poll. This cache belongs only to this synchronous read,
    // so category renames, moves and removals are visible on the next call.
    const categoryBySibling = new WeakMap();
    const categoryFor = item => {
      const visited = [];
      let group = '';
      for (let previous = item?.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (categoryBySibling.has(previous)) { group = categoryBySibling.get(previous); break; }
        visited.push(previous);
        const heading = previous.querySelector('[class*="categoryName"], [class*="name_"][role="heading"], h3');
        if (heading) { group = clean(heading.textContent); break; }
      }
      for (const previous of visited) categoryBySibling.set(previous, group);
      return group;
    };
    for (const link of nodes('a[href^="/channels/"]')) {
      if (hidden(link)) continue;
      if (link.closest(`${ROW}, [id^="message-content-"], [role="dialog"], [class*="guilds_"]`)) continue;
      const raw = link.getAttribute('href').split(/[?#]/)[0].replace(/\/$/, '');
      if (!/^\/channels\/(?:@me|\d+)\/\d+$/.test(raw)) continue;
      if (!link.closest('nav, aside, [class*="sidebar"], [class*="privateChannels"], [data-list-id="channels"], [data-list-item-id^="channels___"], [data-list-item-id^="private-channels"]')) continue;
      const parts = raw.split('/');
      const kind = parts[2] === '@me' ? 'dm' : 'channel';
      const group = kind === 'dm' ? 'direct' : categoryFor(link.closest('li, [data-list-item-id]'));
      found.set(raw, { element: link, id: parts[3], key: 'route:' + raw, route: raw, name: channelName(link) || parts[3], kind, group: group || 'channels' });
    }
    return [...found.values()];
  }

  function identity() {
    if (readContext?.identity) return readContext.identity;
    const identities = new Map();
    // Account switching can temporarily leave the previous panel mounted. Only
    // visible panels and visible account details may identify the active user.
    // Nested copies with the same ID are deduplicated; conflicting IDs remain
    // ambiguous regardless of whether the panels are siblings or nested.
    const panels = nodes('[class*="panels_"]').filter(panel => !hidden(panel));
    for (const panel of panels) {
      const avatar = nodes('img[src*="/avatars/"]', panel).find(element => !hidden(element));
      const id = (avatar?.getAttribute('src') || '').match(/\/avatars\/(\d+)\//)?.[1] || '';
      const nameElement = nodes('[class*="username_"]', panel).find(element => !hidden(element)) ||
        nodes('[class*="title_"]', panel).find(element => !hidden(element));
      const name = clean(nameElement?.textContent);
      if (id || name) identities.set(id ? 'id:' + id : 'name:' + name, { id, name });
    }
    // Conflicting visible account panels are a transition, not proof of identity.
    const value = identities.size === 1 ? identities.values().next().value : { id: '', name: '' };
    if (readContext) readContext.identity = value;
    return value;
  }

  function mediaFor(row) {
    const found = new Map();
    for (const element of nodes('a[href], img[src], video', row)) {
      if (element.closest('[id^="message-content-"], h3, [class*="repliedMessage"], [class*="reactions_"]')) continue;
      if (/avatar|emoji|roleIcon/i.test(element.className || '')) continue;
      const value = element.matches('a') ? element.href : element.currentSrc || element.src || element.poster;
      let url;
      try { url = new URL(value); } catch { continue; }
      if (url.protocol !== 'https:') continue;
      const file = /\/(?:attachments|ephemeral-attachments)\//.test(url.pathname);
      const media = element.matches('img,video') && !/\/avatars\//.test(url.pathname);
      if (!file && !media) continue;
      // Discord's anchor and resized image commonly use different CDN hosts.
      const key = ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) ? url.pathname : url.origin + url.pathname;
      if (found.has(key)) continue;
      let filename = url.pathname.split('/').at(-1) || 'attachment';
      try { filename = decodeURIComponent(filename); } catch {}
      found.set(key, { url: url.href, name: clean(element.getAttribute('alt') || (element.matches('a') ? element.textContent : '') || filename).slice(0, 200), type: element.matches('video') || /\.(?:mp4|webm)$/i.test(filename) ? 'video' : element.matches('img') || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(filename) ? 'image' : 'file' });
    }
    return [...found.values()].slice(0, 12);
  }

  function messages() {
    const self = identity();
    const channelId = route().split('/')[3];
    let previousAuthor = '';
    let previousAuthorId = '';
    return rowElements().filter(row => !channelId || !messageChannelId(row) || messageChannelId(row) === channelId).map((row, index) => {
      const ownElement = selector => nodes(selector, row).find(element => !element.closest('[class*="repliedMessage"], [class*="reactions_"]'));
      const content = ownElement('[id^="message-content-"]');
      const username = ownElement('[id^="message-username-"], h3 [class*="username_"]');
      const avatar = ownElement('img[class*="avatar_"][src*="/avatars/"]');
      const ownId = (avatar?.getAttribute('src') || '').match(/\/avatars\/(\d+)\//)?.[1] || '';
      if (username) { previousAuthor = textOf(username, { exclude: '[class*="badge"], [class*="Badge"], [class*="clan"], [class*="Clan"], svg' }); previousAuthorId = ownId; }
      else if (ownId) previousAuthorId = ownId;
      const author = previousAuthor;
      const timeElement = ownElement('time');
      const text = textOf(content, { multiline: true });
      const media = mediaFor(row);
      if (!text && !media.length) return null;
      const pendingSelector = '[class*="isSending_"], [class*="messageSending"], [data-sending="true"]';
      const failedSelector = '[class*="isFailed_"], [class*="messageFailed"], [data-failed="true"]';
      const pending = row.matches(pendingSelector) || !!row.querySelector(pendingSelector);
      const failed = row.matches(failedSelector) || !!row.querySelector(failedSelector);
      return { id: row.id || row.getAttribute('data-list-item-id') || String(index), author: author || '메시지', text, time: clean(timeElement?.getAttribute('datetime') || timeElement?.textContent), own: !!((self.id && previousAuthorId === self.id) || (!self.id && self.name && author === self.name)), media, pending, failed };
    }).filter(Boolean);
  }

  function snapshot() {
    const previousContext = readContext;
    readContext = { visibility: new WeakMap(), rows: null, identity: null };
    try { return readSnapshot(); }
    finally { readContext = previousContext; }
  }

  function readSnapshot() {
    const currentRoute = route();
    const composer = getComposer();
    const nativeGuilds = guildElements();
    const nativeChannels = channelElements();
    const loggedIn = CHANNEL_ROUTE.test(currentRoute) && !!(composer || nativeGuilds.length || nativeChannels.length || document.querySelector('[data-list-id="chat-messages"], [class*="privateChannels_"]'));
    const active = nativeChannels.find(channel => channel.route === currentRoute);
    const titleElement = document.querySelector('main [class*="title_"] h1, [class*="titleWrapper_"] h1, [class*="titleWrapper_"] [class*="title_"], [class*="subtitleContainer_"] h1');
    const title = active?.name || clean(titleElement?.textContent) || (currentRoute === '/channels/@me' ? '대화를 선택하세요' : 'discord');
    const guildId = currentRoute.split('/')[2];
    const guildName = guildId === '@me' ? 'direct' : nativeGuilds.find(guild => guild.id === guildId)?.name || clean(document.querySelector('[class*="sidebar_"] [class*="header_"] h1, [class*="sidebarList_"] [class*="header_"] h1')?.textContent) || 'channels';
    const hasDialog = dialogs().length > 0;
    const ready = routeReady();
    const stripElement = ({ element, ...data }) => data;
    return { loggedIn, accountId: loggedIn ? identity().id : '', route: currentRoute, title, guildName, guilds: nativeGuilds.map(stripElement), channels: nativeChannels.map(stripElement), rows: loggedIn && CHAT_ROUTE.test(currentRoute) && ready ? messages() : [], canSend: loggedIn && CHAT_ROUTE.test(currentRoute) && ready && !!composer && !hasDialog, hasDialog, draftText: draftText(composer), routeReady: ready };
  }

  function open(key) {
    if (typeof key !== 'string' || key.length > 160) return { ok: false, error: '대화 주소가 올바르지 않습니다.' };
    if (dialogs().length) return { ok: false, error: 'Discord의 열린 안내창을 먼저 닫아주세요.' };
    const target = [...guildElements(), ...channelElements()].find(item => item.key === key);
    if (!target?.element?.isConnected) return { ok: false, error: '목록이 변경되었습니다. 새로고침 후 다시 선택하세요.' };
    target.element.click();
    return { ok: true };
  }

  function composerState(expectedRoute) {
    const currentRoute = route();
    const composer = getComposer();
    const hasDialog = dialogs().length > 0;
    const ready = routeReady();
    const canSend = CHAT_ROUTE.test(currentRoute) && ready && !!composer && !hasDialog;
    const focused = !!composer && (document.activeElement === composer || composer.contains(document.activeElement));
    return { ok: currentRoute === expectedRoute && canSend, text: draftText(composer), route: currentRoute, canSend, hasDialog, focused, routeReady: ready };
  }

  function focusComposer(expectedRoute) {
    const state = composerState(expectedRoute);
    if (!state.ok) return { ...state, error: '대화가 바뀌었거나 입력창이 준비되지 않았습니다.' };
    if (state.text) return { ...state, ok: false, draftText: state.text, error: '원래 Discord 입력창에 작성 중인 내용이 있습니다. 원래 화면에서 확인해주세요.' };
    const composer = getComposer();
    if (!composer) return { ok: false, error: '입력창이 변경되었습니다. 다시 확인해주세요.' };
    composer.focus();
    // Focusing can synchronously trigger a Discord navigation or open a dialog.
    const after = composerState(expectedRoute);
    const focused = after.ok && after.focused && getComposer() === composer;
    return { ok: focused && !after.text, draftText: after.text, route: after.route, focused };
  }

  function scroll(direction, expectedRoute) {
    if (![-1, 1].includes(direction) || route() !== expectedRoute || !routeReady()) return { ok: false };
    const row = rowElements()[0];
    let target = row?.parentElement;
    while (target && target !== document.body) {
      if (/auto|scroll/.test(getComputedStyle(target).overflowY)) break;
      target = target.parentElement;
    }
    target = target && target !== document.body ? target : document.querySelector('[class*="messagesWrapper_"] [class*="scroller_"]');
    if (!target) return { ok: false };
    target.scrollBy({ top: (direction < 0 ? -1 : 1) * Math.max(500, target.clientHeight * 0.8), behavior: 'instant' });
    return { ok: true };
  }

  // No listeners or timers are retained, making repeated injection idempotent.
  window.__vdcAdapter = { snapshot, open, focusComposer, composerState, scroll };
})();
