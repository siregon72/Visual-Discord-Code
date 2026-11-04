'use strict';

// Fast, dependency-free checks used before packaging. Does not start Discord.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const skipped = new Set(['node_modules', 'dist', 'test-results', 'coverage', '.git']);

function files(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (skipped.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? files(target) : entry.isFile() ? [target] : [];
  });
}

const sourceFiles = files(root);
for (const filename of sourceFiles.filter(file => /\.(?:c?js|mjs)$/.test(file))) {
  const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || String(result.error));
    process.exit(1);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (lock.version !== manifest.version || lock.packages[''].version !== manifest.version) {
  throw new Error('package.json and package-lock.json versions differ.');
}
for (const entry of manifest.build.files) {
  const target = path.resolve(root, entry.replace(/\/\*\*$/, ''));
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) {
    throw new Error(`Missing or invalid packaged path: ${entry}`);
  }
}

const html = fs.readFileSync(path.join(root, 'live.html'), 'utf8');
for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  if (/^(?:https?:|data:|#)/.test(reference)) continue;
  const target = path.resolve(root, reference);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) {
    throw new Error(`Missing or invalid renderer resource: ${reference}`);
  }
}
console.log(`Syntax, renderer resources, package inputs and version ${manifest.version} verified.`);
