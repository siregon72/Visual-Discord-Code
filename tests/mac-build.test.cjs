'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseOptions, requireNotarization, macConfiguration } = require('../scripts/build-mac.cjs');
const { requireMac, verifyMacApp } = require('../scripts/verify-mac.cjs');

test('Mac builds default to a signed release and Apple Silicon; friend builds require an explicit mode', () => {
  assert.deepEqual(parseOptions([]), { mode: 'release', arch: 'arm64' });
  assert.deepEqual(parseOptions(['--friend', '--arch', 'x64']), { mode: 'friend', arch: 'x64' });
  assert.deepEqual(parseOptions(['--arch=arm64', '--release']), { mode: 'release', arch: 'arm64' });
  for (const args of [['--friend', '--release'], ['--arch', 'universal'], ['--arch'], ['--arch=x64', '--arch=arm64'], ['--unsigned']]) assert.throws(() => parseOptions(args));
  assert.throws(() => requireMac('win32'), /must run on macOS/);
  assert.throws(() => verifyMacApp('missing.app', { platform: 'linux' }), /must run on macOS/);
});

test('release notarization credentials follow builder precedence and cannot silently fall back', () => {
  assert.throws(() => requireNotarization({}), /requires notarization/);
  assert.throws(() => requireNotarization({ APPLE_ID: 'test@example.com', APPLE_KEYCHAIN_PROFILE: 'saved' }), /Incomplete/);
  assert.throws(() => requireNotarization({ APPLE_API_KEY_ID: 'key', APPLE_KEYCHAIN_PROFILE: 'saved' }), /Incomplete/);
  assert.doesNotThrow(() => requireNotarization({ APPLE_TEAM_ID: 'ABCDEFGHIJ', APPLE_KEYCHAIN_PROFILE: 'saved' }));
  assert.doesNotThrow(() => requireNotarization({ APPLE_ID: 'test@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'password', APPLE_TEAM_ID: 'ABCDEFGHIJ' }));
  assert.doesNotThrow(() => requireNotarization({ APPLE_API_KEY: '/private/key.p8', APPLE_API_KEY_ID: 'key', APPLE_API_ISSUER: 'issuer' }));
  assert.throws(() => macConfiguration('release', '/out', { CSC_NAME: '-', APPLE_KEYCHAIN_PROFILE: 'saved' }), /ad-hoc/);
});

test('both native signing configurations satisfy the installed builder schema and require signatures', async () => {
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const friend = macConfiguration('friend', '/out', {});
  const release = macConfiguration('release', '/out', { APPLE_KEYCHAIN_PROFILE: 'saved' });
  await validateConfiguration(friend, {});
  await validateConfiguration(release, {});
  assert.equal(friend.forceCodeSigning, true);
  assert.equal(friend.mac.identity, '-');
  assert.equal(friend.mac.hardenedRuntime, false);
  assert.equal(friend.mac.notarize, false);
  assert.equal(release.forceCodeSigning, true);
  assert.equal(release.mac.hardenedRuntime, true);
  assert.equal(release.mac.notarize, true);
});

test('friend signing stays ad-hoc when builder finds a real certificate whose name contains a hyphen', async t => {
  const signer = require('@electron/osx-sign');
  let received;
  t.mock.method(signer, 'signAsync', async options => { received = options; });
  const friend = macConfiguration('friend', '/out', {});
  await friend.mac.sign({ identity: 'Developer ID Application: Test-Developer (ABCDEFGHIJ)', app: '/out/Test.app', identityValidation: true });
  assert.equal(received.identity, '-');
  assert.equal(received.identityValidation, false);
  assert.equal(received.app, '/out/Test.app');
});

function fixture(t, overrides = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vdc mac verification '));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const app = path.join(temporary, 'Visual Discord Code.app');
  const info = path.join(app, 'Contents', 'Info.plist');
  const executable = path.join(app, 'Contents', 'MacOS', 'Visual Discord Code');
  const helper = path.join(app, 'Contents', 'Frameworks', 'Visual Discord Code Helper.app', 'Contents', 'MacOS', 'Visual Discord Code Helper');
  for (const filename of [info, executable, helper]) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, filename === info ? '<plist/>' : Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  }
  const calls = [];
  const options = { platform: 'darwin', mode: 'friend', arch: 'arm64', version: '0.3.11', electronVersion: '45.2.1' };
  options.run = (command, args, runOptions = {}) => {
    calls.push({ command, args, options: runOptions });
    if (overrides.failCommand && command === overrides.failCommand) throw new Error('native command rejected artifact');
    if (command.endsWith('PlistBuddy')) {
      const key = args[1].slice('Print :'.length);
      return { CFBundleShortVersionString: overrides.version || options.version, CFBundleVersion: options.version,
        CFBundleIdentifier: 'local.visualdiscordcode.desktop', CFBundleExecutable: 'Visual Discord Code' }[key] + '\n';
    }
    if (command.endsWith('lipo')) return args.at(-1) === helper && overrides.helperCPU ? overrides.helperCPU : 'arm64\n';
    if (command.endsWith('codesign') && args.includes('--display')) return overrides.signature || 'CodeDirectory v=20400 size=200 flags=0x2(adhoc) hashes=1+7\nSignature=adhoc\nTeamIdentifier=not set\n';
    if (command === executable) return 'VDC_MAC_SMOKE=' + JSON.stringify({ version: options.version, name: 'visual-discord-code', electron: options.electronVersion, platform: 'darwin', arch: 'arm64', ...overrides.runtime }) + '\n';
    return '';
  };
  return { app, executable, helper, calls, options };
}

test('native verification checks helper CPU, full resource seal, and the packaged runtime using argv paths with spaces', t => {
  const item = fixture(t);
  const result = verifyMacApp(item.app, item.options);
  assert.equal(result.bundleSignature, 'verified-deep-strict');
  assert.equal(result.machOBinaries, 2);
  assert.equal(result.guiLaunchTested, false);
  assert.equal(result.notarized, false);
  const verification = item.calls.find(call => call.command.endsWith('codesign') && call.args.includes('--verify'));
  assert.deepEqual(verification.args, ['--verify', '--deep', '--strict', '--verbose=2', item.app]);
  const execution = item.calls.find(call => call.command === item.executable);
  assert.equal(execution.args.at(-1), path.join(item.app, 'Contents', 'Resources', 'app.asar', 'package.json'));
  assert.equal(execution.options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(item.calls.some(call => call.command.endsWith('spctl')), false);
});

test('native verification rejects wrong bundle versions, wrong helper CPU and mismatched executable runtime', t => {
  for (const overrides of [{ version: '0.0.0' }, { helperCPU: 'x86_64\n' }, { runtime: { electron: '0.0.0' } }, { runtime: { arch: 'x64' } }]) {
    const item = fixture(t, overrides);
    assert.throws(() => verifyMacApp(item.app, item.options), /version|architecture|runtime/);
  }
});

const developerSignature = 'CodeDirectory v=20500 size=200 flags=0x10000(runtime) hashes=1+7\nAuthority=Developer ID Application: Test Developer (ABCDEFGHIJ)\nAuthority=Developer ID Certification Authority\nTeamIdentifier=ABCDEFGHIJ\n';

test('release verification refuses ad-hoc signing and friend verification refuses hardened runtime', t => {
  const adhoc = fixture(t);
  assert.throws(() => verifyMacApp(adhoc.app, { ...adhoc.options, mode: 'release' }), /Developer ID/);
  assert.equal(adhoc.calls.some(call => call.command.endsWith('spctl')), false);
  const hardened = fixture(t, { signature: developerSignature });
  assert.throws(() => verifyMacApp(hardened.app, hardened.options), /ad-hoc/);
});

test('release acceptance requires successful deep signing, stapled notarization and Gatekeeper assessment', t => {
  const good = fixture(t, { signature: developerSignature });
  const result = verifyMacApp(good.app, { ...good.options, mode: 'release' });
  assert.equal(result.notarized, true);
  assert.ok(good.calls.some(call => call.command.endsWith('xcrun') && call.args[0] === 'stapler'));
  assert.ok(good.calls.some(call => call.command.endsWith('spctl') && call.args.includes('--assess')));
  for (const failCommand of ['/usr/bin/codesign', '/usr/bin/xcrun', '/usr/sbin/spctl']) {
    const rejected = fixture(t, { signature: developerSignature, failCommand });
    assert.throws(() => verifyMacApp(rejected.app, { ...rejected.options, mode: 'release' }), /native command rejected/);
    assert.equal(rejected.calls.some(call => call.command === rejected.executable), false);
  }
});
