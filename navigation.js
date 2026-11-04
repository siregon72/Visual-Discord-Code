'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

function canonicalPath(value) {
  const resolved = path.normalize(fs.realpathSync(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createLocalPageGuard(files) {
  const allowed = new Set(files.map(canonicalPath));
  return value => {
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return false;
      return allowed.has(canonicalPath(fileURLToPath(url)));
    } catch { return false; }
  };
}

function isDiscordURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'discord.com' &&
      !url.username && !url.password && (!url.port || url.port === '443');
  } catch { return false; }
}

function isExternalURL(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

module.exports = { isDiscordURL, isExternalURL, createLocalPageGuard };
