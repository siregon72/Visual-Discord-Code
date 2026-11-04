'use strict';
(() => {
  const { escape, reactIcon, folderChevron } = window.VDCUI;
  function groupId(channel) {
    const segments = String(channel.route || '').split('/');
    return channel.kind === 'dm' || segments[2] === '@me' ? 'direct' : segments[2] || channel.group || 'channels';
  }

  function createExplorer({tree, openConversation, showHelp, fileNames}) {
    let treeSignature = '';
  function renderTree(snap, channels, guilds, collapsed, manualHelp) {
    const query = '';
    const focusKey = document.activeElement?.dataset?.focusKey;
    const list = [...channels.values()];
    const signature = JSON.stringify([list, [...guilds.values()], query, snap.route, [...collapsed], manualHelp, snap.loggedIn, fileNames.enabled]);
    if (signature === treeSignature) return;
    treeSignature = signature;
    tree.replaceChildren();
    const groups = [{ id: 'direct', name: 'direct', key: 'route:/channels/@me' }, ...[...guilds.values()].filter(guild => !['home', '@me', 'direct'].includes(String(guild.id))).map(guild => ({ id: String(guild.id), name: guild.name || '서버', key: guild.key }))];
    for (const channel of list) {
      const id = groupId(channel);
      if (!groups.some(group => group.id === id)) groups.push({ id, name: channel.group || snap.guildName || 'channels', key: '' });
    }
    for (const group of groups) {
      const items = list.filter(channel => groupId(channel) === group.id && (!query || `${channel.name} ${group.name}`.toLocaleLowerCase().includes(query)));
      if (query && !items.length && !group.name.toLocaleLowerCase().includes(query)) continue;
      const heading = document.createElement('div'); heading.className = 'guild-heading';
      const toggle = document.createElement('button'); toggle.className = 'folder-toggle'; toggle.innerHTML = folderChevron; toggle.setAttribute('aria-label', `${group.name} 폴더 접기 / 펴기`); toggle.setAttribute('aria-expanded', String(!collapsed.has(group.id) || !!query));
      toggle.dataset.focusKey = 'toggle:' + group.id;
      toggle.addEventListener('click', () => { collapsed.has(group.id) ? collapsed.delete(group.id) : collapsed.add(group.id); renderTree(snap, channels, guilds, collapsed, manualHelp); });
      const folder = document.createElement('button'); folder.className = 'folder-header'; folder.innerHTML = `<span class="folder-title">${escape(group.name)}</span>`;
      folder.dataset.focusKey = 'folder:' + group.id;
      folder.addEventListener('click', () => { collapsed.delete(group.id); if (group.key) void openConversation(group.key); else renderTree(snap, channels, guilds, collapsed, manualHelp); });
      heading.append(toggle, folder); tree.append(heading);
      if (!collapsed.has(group.id) || query) {
        if (!items.length && snap.loggedIn && (group.id === 'direct' || String(snap.route.split('/')[2]) === group.id)) {
          const hint = document.createElement('div'); hint.className = 'folder-subtitle'; hint.textContent = query ? '검색 결과 없음' : '폴더를 눌러 대화 불러오기'; tree.append(hint);
        }
        for (const channel of items) {
          const filename = fileNames.filename(channel);
          const button = document.createElement('button');
          button.className = `file-row subfile${channel.route === snap.route && !manualHelp ? ' active' : ''}`;
          button.setAttribute('aria-label', `${filename} 대화 열기`);
          if (channel.route === snap.route && !manualHelp) button.setAttribute('aria-current', 'page');
          button.innerHTML = `${reactIcon}<span class="filename">${escape(filename)}</span>`;
          button.dataset.focusKey = channel.route;
          button.addEventListener('click', () => { void openConversation(channel.key); });
          tree.append(button);
        }
      }
    }
    if (!snap.loggedIn && !list.length) { const hint = document.createElement('div'); hint.className = 'tree-empty'; hint.textContent = '로그인하면 실제 서버와 대화 목록이 여기에 표시됩니다.'; tree.append(hint); }
    const readme = document.createElement('button'); readme.className = 'file-row readme-row'; readme.innerHTML = '<span class="md-icon">M↓</span><span>README.md</span>'; readme.dataset.focusKey = 'readme'; readme.addEventListener('click', showHelp); tree.append(readme);
    if (focusKey) [...tree.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }

    return {render: renderTree};
  }
  window.VDCUI.createExplorer = createExplorer;
})();
