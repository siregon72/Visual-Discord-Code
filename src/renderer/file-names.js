'use strict';
(() => {
  const STORAGE_KEY = 'vdc.file-names.v1';
  const CHAT_ROUTE = /^\/channels\/(?:@me|\d+)\/\d+$/;
  const FILES = [
    'layout.jsx', 'page.jsx', 'App.tsx', 'Header.tsx', 'Sidebar.tsx', 'Navbar.tsx',
    'Footer.tsx', 'Content.tsx', 'Dashboard.tsx', 'Profile.tsx', 'Settings.tsx',
    'Button.tsx', 'Input.tsx', 'Search.tsx', 'Card.tsx', 'Modal.tsx', 'Dialog.tsx',
    'Dropdown.tsx', 'Menu.tsx', 'Tabs.tsx', 'Tooltip.tsx', 'Avatar.tsx', 'Badge.tsx',
    'Table.tsx', 'List.tsx', 'Grid.tsx', 'Form.tsx', 'Select.tsx', 'Checkbox.tsx',
    'Switch.tsx', 'Pagination.tsx', 'Breadcrumb.tsx', 'Skeleton.tsx', 'Spinner.tsx',
    'ThemeProvider.tsx', 'Providers.tsx', 'ErrorBoundary.tsx', 'Loading.tsx',
    'NotFound.tsx', 'Home.tsx', 'Detail.tsx', 'Workspace.tsx', 'Toolbar.tsx',
    'Panel.tsx', 'Section.tsx', 'Container.tsx', 'AppShell.tsx', 'Navigation.tsx'
  ];
  const patterns = FILES.map(file => {
    const dot = file.lastIndexOf('.');
    return new RegExp('^' + file.slice(0, dot) + '(?:[2-9]|[1-9][0-9]+)?\\' + file.slice(dot) + '$');
  });
  const validRoute = route => typeof route === 'string' && route.length <= 160 && CHAT_ROUTE.test(route);
  const validAlias = alias => typeof alias === 'string' && alias.length <= 100 && patterns.some(pattern => pattern.test(alias));

  /**
   * Persistent display names keyed only by conversation route.
   * createFileNames() uses localStorage; pass a Storage-like object for tests,
   * or null for an in-memory provider. assign(records) allocates in one batch;
   * filename({route, name}) returns the alias when enabled, otherwise name.tsx.
   * Only the enabled flag and route-to-alias mapping are persisted.
   */
  function createFileNames(storage = undefined) {
    if (storage === undefined) {
      try { storage = window.localStorage; } catch { storage = null; }
    }
    const aliases = new Map();
    const used = new Set();
    let enabled = false;
    let cursor = 0;
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        enabled = saved.enabled === true;
        if (saved.aliases && typeof saved.aliases === 'object' && !Array.isArray(saved.aliases)) {
          for (const [route, alias] of Object.entries(saved.aliases)) {
            if (!validRoute(route) || !validAlias(alias) || used.has(alias)) continue;
            aliases.set(route, alias); used.add(alias);
          }
        }
      }
    } catch { /* Missing, malformed, or blocked storage starts with memory-only defaults. */ }

    function save() {
      try { storage?.setItem(STORAGE_KEY, JSON.stringify({ enabled, aliases: Object.fromEntries(aliases) })); }
      catch { /* Quota/private-mode failures must not interrupt navigation. */ }
    }
    function allocate(route) {
      if (aliases.has(route)) return false;
      let candidate;
      do {
        const file = FILES[cursor % FILES.length];
        const cycle = Math.floor(cursor / FILES.length) + 1;
        candidate = cycle === 1 ? file : file.replace(/(\.(?:jsx|tsx))$/, cycle + '$1');
        cursor++;
      } while (used.has(candidate));
      aliases.set(route, candidate); used.add(candidate);
      return true;
    }
    return Object.freeze({
      get enabled() { return enabled; },
      toggle() { enabled = !enabled; save(); return enabled; },
      assign(records) {
        if (!records || typeof records[Symbol.iterator] !== 'function') return;
        // Stable ordering on the first batch; existing assignments never move.
        const routes = new Set();
        for (const record of records) if (validRoute(record?.route) && !aliases.has(record.route)) routes.add(record.route);
        let changed = false;
        for (const route of [...routes].sort()) changed = allocate(route) || changed;
        if (changed) save();
      },
      filename(channel) {
        const realName = (typeof channel?.name === 'string' && channel.name ? channel.name : 'inbox') + '.tsx';
        if (!enabled || !validRoute(channel?.route)) return realName;
        if (allocate(channel.route)) save();
        return aliases.get(channel.route);
      }
    });
  }
  window.VDCUI.createFileNames = createFileNames;
})();
