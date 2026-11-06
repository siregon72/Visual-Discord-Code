'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../scripts/macos-repair.sh'), 'utf8');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
const hasBash = fs.existsSync(bash);

function shellPath(value) {
  return value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

function fixture(t, { tamper = false, extra = false, badLink = false, failVerify = false, quarantine = 'normal', platform = 'Darwin', arm = '1', version = '26.0' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdc-mac-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = path.join(root, 'tools');
  fs.mkdirSync(tools);
  const files = [
    'Visual Discord Code.app/Contents/MacOS/Visual Discord Code',
    'Visual Discord Code.app/Contents/Info.plist',
    'Visual Discord Code.app/Contents/Resources/app.asar',
    'Visual Discord Code.app/Contents/Frameworks/Test.framework/Versions/A/Test',
    'Visual Discord Code.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper',
  ];
  for (const relative of files) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), relative);
  }
  const manifest = files.map(relative => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')}  ${relative}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'macos-repair-manifest.txt'), manifest);
  fs.writeFileSync(path.join(root, 'macos-repair-symlinks.txt'), badLink ? 'Visual Discord Code.app/Contents/invalid-link\tResources\n' : '');
  if (tamper) fs.appendFileSync(path.join(root, files[0]), 'changed');
  if (extra) fs.writeFileSync(path.join(root, 'Visual Discord Code.app/Contents/unlisted'), 'extra');
  const mocks = {
    uname: `printf '%s\\n' '${platform}'`,
    sysctl: `printf '%s\\n' '${arm}'`,
    sw_vers: `printf '%s\\n' '${version}'`,
    shasum: 'shift 2\nsha256sum "$@"',
    file: 'case "$2" in *MacOS*|*/Versions/A/Test) printf "Mach-O 64-bit executable arm64\\n";; *) printf "data\\n";; esac',
    codesign: 'printf "codesign\\t%s\\n" "$*" >> "$VDC_TEST_EVENTS"\n' + (failVerify ? 'case "$1" in --verify) exit 1;; esac' : ':'),
    xattr: 'printf "xattr\\t%s\\n" "$*" >> "$VDC_TEST_EVENTS"\n' + (quarantine === 'normal' ? ':' : 'if [[ "$1" == -dr ]]; then exit 1; fi\n' + (quarantine === 'persists' ? "printf 'com.apple.quarantine: present\\n'" : ':')),
    open: 'printf "open\\t%s\\n" "$*" >> "$VDC_TEST_EVENTS"',
  };
  let instrumented = source;
  for (const [name, body] of Object.entries(mocks)) {
    const location = path.join(tools, name);
    fs.writeFileSync(location, '#!/bin/bash\nset -eu\n' + body + '\n', { mode: 0o755 });
    instrumented = instrumented.replaceAll(`/usr/bin/${name}`, `${shellPath(location)}`).replaceAll(`/usr/sbin/${name}`, `${shellPath(location)}`);
  }
  const script = path.join(root, 'First-Run.command');
  fs.writeFileSync(script, instrumented);
  const log = path.join(root, 'events.txt');
  const result = spawnSync(bash, [shellPath(script)], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, VDC_TEST_EVENTS: shellPath(log), TMPDIR: shellPath(root), MSYS_NO_PATHCONV: '1' },
  });
  return { ...result, events: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [] };
}

test('macOS repair shell syntax is valid', { skip: !hasBash }, () => {
  const result = spawnSync(bash, ['-n', shellPath(path.join(__dirname, '../scripts/macos-repair.sh'))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('a changed downloaded binary stops repair before signing or quarantine changes', { skip: !hasBash }, t => {
  const result = fixture(t, { tamper: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /파일 해시가 다릅니다/);
  assert.deepEqual(result.events, []);
});

test('unlisted files stop repair before any app mutation', { skip: !hasBash }, t => {
  const result = fixture(t, { extra: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /추가되거나 누락된 파일/);
  assert.deepEqual(result.events, []);
});

test('a missing expected framework link stops repair before any app mutation', { skip: !hasBash }, t => {
  const result = fixture(t, { badLink: true });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /심볼릭 링크가 손상/);
  assert.deepEqual(result.events, []);
});

test('native verification failure never removes quarantine or opens the app', { skip: !hasBash }, t => {
  const result = fixture(t, { failVerify: true });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.events.some(line => line.startsWith('codesign\t--verify --deep --strict')));
  assert.ok(result.events.every(line => line.startsWith('codesign\t')));
});

test('repair signs children before the app and opens only after strict verification', { skip: !hasBash }, t => {
  const result = fixture(t);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const verify = result.events.findIndex(line => line.startsWith('codesign\t--verify'));
  assert.ok(verify > 1);
  assert.match(result.events[verify - 1], /Visual Discord Code\.app$/);
  assert.ok(result.events.slice(0, verify - 1).every(line => line.includes('/Contents/')));
  assert.match(result.events[verify + 1], /^xattr\t-dr com\.apple\.quarantine .*Visual Discord Code\.app$/);
  assert.match(result.events[verify + 2], /^open\t.*Visual Discord Code\.app$/);
  assert.equal(result.events.length, verify + 3);
});

test('non-macOS execution fails without changing app files', { skip: !hasBash }, t => {
  const result = fixture(t, { platform: 'Linux' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Apple Silicon Mac 전용/);
  assert.deepEqual(result.events, []);
});

test('Intel hosts and unsupported macOS versions fail before any app mutation', { skip: !hasBash }, t => {
  for (const options of [{ arm: '0' }, { version: '12.7' }]) {
    const result = fixture(t, options);
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(result.events, []);
  }
});

test('quarantine removal failure never opens an app if quarantine remains', { skip: !hasBash }, t => {
  const result = fixture(t, { quarantine: 'persists' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /격리 표시를 해제하지 못했습니다/);
  assert.ok(result.events.every(line => !line.startsWith('open\t')));
});

test('an absent quarantine attribute is accepted only after recursive confirmation', { skip: !hasBash }, t => {
  const result = fixture(t, { quarantine: 'absent' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.events.at(-2), /^xattr\t-lr /);
  assert.match(result.events.at(-1), /^open\t/);
});
