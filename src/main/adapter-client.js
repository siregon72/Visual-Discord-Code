'use strict';

const METHODS = new Set(['snapshot', 'open', 'focusComposer', 'composerState', 'scroll']);

class StaleGuestError extends Error {
  constructor() { super('Discord document changed'); this.name = 'StaleGuestError'; }
}

function createAdapterClient({ source, isDiscordURL, timeoutMs = 4000 }) {
  const installed = new WeakSet();
  return async function invoke(wc, method, args = [], isCurrent = () => true) {
    if (!METHODS.has(method)) throw new Error('Unsupported adapter action');
    if (!wc || wc.isDestroyed() || !isCurrent() || !isDiscordURL(wc.getURL())) throw new StaleGuestError();
    const deadline = Date.now() + timeoutMs;
    // Queued mutations also expire inside the isolated world, preventing a timed-out
    // navigation/focus request from taking effect when a stalled renderer resumes.
    async function execute(bootstrap) {
      if (wc.isDestroyed() || !isCurrent() || !isDiscordURL(wc.getURL())) throw new StaleGuestError();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Discord adapter timed out');
      const install = bootstrap ? source : 'return { __vdcAdapterMissing: true };';
      const code = `(() => { if (Date.now() > ${deadline}) return { ok: false, expired: true }; if (!window.__vdcAdapter) { ${install}\n } return window.__vdcAdapter[${JSON.stringify(method)}](...${JSON.stringify(args)}); })()`;
      let timeout;
      try {
        const pending = wc.executeJavaScriptInIsolatedWorld(1001, [{ code }], true);
        const result = await Promise.race([pending, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Discord adapter timed out')), remaining);
        })]);
        if (wc.isDestroyed() || !isCurrent()) throw new StaleGuestError();
        if (result?.expired) throw new Error('Discord adapter timed out');
        return result;
      } finally { clearTimeout(timeout); }
    }
    // Once installed, send only the tiny dispatcher across the process boundary.
    // A full navigation clears the isolated world: reinstall only when the probe
    // confirms the adapter is absent and no action has run, under the same deadline.
    let result = await execute(!installed.has(wc));
    if (result?.__vdcAdapterMissing === true) {
      installed.delete(wc);
      result = await execute(true);
    }
    installed.add(wc);
    return result;
  };
}

module.exports = { createAdapterClient, StaleGuestError };
