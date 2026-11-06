'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { requireMac, runCommand, verifyMacApp } = require('./verify-mac.cjs');
const root = path.resolve(__dirname, '..');

function parseOptions(args) {
  let mode = 'release', selectedMode = false, arch = 'arm64', selectedArch = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--friend' || argument === '--release') {
      if (selectedMode) throw new Error('Choose exactly one signing mode: --release or --friend.');
      mode = argument.slice(2); selectedMode = true;
    } else if (argument === '--arch' || argument.startsWith('--arch=')) {
      if (selectedArch) throw new Error('Choose one architecture.');
      arch = argument === '--arch' ? args[++index] : argument.slice(7); selectedArch = true;
      if (!['arm64', 'x64'].includes(arch)) throw new Error('Architecture must be arm64 (Apple Silicon) or x64 (Intel).');
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  return { mode, arch };
}

function requireNotarization(env = process.env) {
  // These are the three authentication forms supported by the installed builder.
  const groups = [
    { triggers: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD'], keys: ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'] },
    { triggers: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'], keys: ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'] },
    { triggers: ['APPLE_KEYCHAIN_PROFILE'], keys: ['APPLE_KEYCHAIN_PROFILE'] }
  ];
  // Builder prioritizes Apple ID over API key, then keychain profile. Reject
  // incomplete higher-priority forms rather than silently using another one.
  for (const group of groups) {
    if (group.triggers.some(key => env[key])) {
      if (!group.keys.every(key => env[key])) throw new Error(`Incomplete notarization configuration; set ${group.keys.join(', ')}.`);
      return;
    }
  }
  throw new Error('Release requires notarization credentials (APPLE_KEYCHAIN_PROFILE, or a complete Apple ID/API key configuration). Use --friend only for an explicitly ad-hoc test build.');
}

function macConfiguration(mode, output, env = process.env) {
  if (!['friend', 'release'].includes(mode)) throw new Error('Invalid signing mode.');
  if (mode === 'release') {
    requireNotarization(env);
    if (env.CSC_NAME === '-') throw new Error('An ad-hoc identity cannot be used for a release.');
  }
  return {
    directories: { output },
    forceCodeSigning: true,
    disableAsarIntegrity: false,
    mac: {
      target: 'dir',
      type: 'distribution',
      identity: mode === 'friend' ? '-' : env.CSC_NAME || undefined,
      // The installed builder looks up '-' as a certificate-name substring
      // before its ad-hoc fallback. Force the final signer to use '-' even
      // when a real certificate name happens to contain a hyphen.
      sign: mode === 'friend' ? async signOptions => require('@electron/osx-sign').signAsync({ ...signOptions, identity: '-', identityValidation: false }) : undefined,
      hardenedRuntime: mode === 'release',
      notarize: mode === 'release',
      strictVerify: true,
      gatekeeperAssess: false,
      preAutoEntitlements: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.plist',
      category: 'public.app-category.developer-tools',
      minimumSystemVersion: '13.0'
    }
  };
}

async function main(args = process.argv.slice(2)) {
  requireMac();
  const options = parseOptions(args);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // Fail before building if a release would skip notarization.
  if (options.mode === 'release') requireNotarization();
  runCommand(process.execPath, [path.join(root, 'scripts', 'check.cjs')], { cwd: root, timeout: 60_000 });
  const tests = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.cjs')).map(name => path.join(root, 'tests', name));
  runCommand(process.execPath, ['--test', ...tests], { cwd: root, timeout: 120_000 });
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  const output = fs.mkdtempSync(path.join(root, 'dist', `native-mac-${manifest.version}-${options.mode}-${options.arch}-`));
  const { build, Platform, Arch } = require('electron-builder');
  await build({
    projectDir: root,
    targets: Platform.MAC.createTarget(['dir'], Arch[options.arch]),
    publish: 'never',
    config: macConfiguration(options.mode, output)
  });
  const apps = fs.readdirSync(output, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^mac(?:-|$)/.test(entry.name))
    .flatMap(entry => fs.readdirSync(path.join(output, entry.name), { withFileTypes: true }).filter(child => child.isDirectory() && child.name.endsWith('.app')).map(child => path.join(output, entry.name, child.name)));
  if (apps.length !== 1) throw new Error('Expected exactly one freshly built macOS app bundle.');
  const appPath = apps[0];
  const expected = { ...options, version: manifest.version, electronVersion: manifest.devDependencies.electron };
  // Validate before compression, then validate the independently extracted final ZIP.
  verifyMacApp(appPath, expected);
  const cpuLabel = options.arch === 'arm64' ? 'AppleSilicon' : 'Intel';
  const artifact = path.join(output, `Visual-Discord-Code-${manifest.version}-macOS-${cpuLabel}-${options.mode === 'friend' ? 'AdHoc-Test' : 'Notarized'}.zip`);
  const pending = `${artifact}.pending-verification`;
  runCommand('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, pending], { timeout: 120_000 });
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'vdc-final-mac-'));
  try {
    runCommand('/usr/bin/ditto', ['-x', '-k', pending, extracted], { timeout: 120_000 });
    const report = verifyMacApp(path.join(extracted, path.basename(appPath)), expected);
    report.artifact = path.basename(artifact);
    report.sha256 = crypto.createHash('sha256').update(fs.readFileSync(pending)).digest('hex');
    report.verifiedAfterZipExtraction = true;
    report.note = 'The packaged executable loaded Electron and app.asar in Node mode. This does not test GUI rendering or Discord login.';
    fs.renameSync(pending, artifact);
    fs.writeFileSync(path.join(output, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), `${report.sha256}  ${report.artifact}\n`);
    if (options.mode === 'friend') {
      fs.writeFileSync(path.join(output, 'README-macOS.txt'), 'Ad-hoc test build. This is not Developer ID signed or notarized. macOS may require explicit approval in Privacy & Security. Use a notarized release for normal distribution.\n');
    }
    console.log(`Verified macOS ${options.arch} ${options.mode} ZIP: ${artifact}`);
  } catch (error) {
    // Leave no deliverable bearing a release-looking name after failed validation.
    const unverified = fs.existsSync(pending) ? pending : artifact;
    if (fs.existsSync(unverified)) fs.renameSync(unverified, `${artifact}.failed-verification`);
    throw error;
  } finally {
    // Only this process's newly-created temp directory is removed.
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { parseOptions, requireNotarization, macConfiguration, main };
