'use strict';

// This check must run on a Mac against the app extracted from the final ZIP.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function requireMac(platform = process.platform) {
  if (platform !== 'darwin') throw new Error('macOS signing and launch verification must run on macOS. Windows ZIP/CRC checks cannot replace it.');
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} failed${result.status === null ? '' : ` (${result.status})`}: ${result.error?.message || ''}\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

const MACHO_MAGICS = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function machOFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    // Framework symlinks point back to their real version; inspect it once.
    if (entry.isDirectory()) result.push(...machOFiles(filename));
    else if (entry.isFile()) {
      const descriptor = fs.openSync(filename, 'r');
      try {
        const magic = Buffer.alloc(4);
        if (fs.readSync(descriptor, magic, 0, 4, 0) === 4 && MACHO_MAGICS.has(magic.readUInt32BE())) result.push(filename);
      } finally { fs.closeSync(descriptor); }
    }
  }
  return result;
}

function verifyMacApp(appPath, options = {}) {
  requireMac(options.platform);
  const { arch = 'arm64', mode = 'release', version, electronVersion, appId = 'local.visualdiscordcode.desktop', run = runCommand } = options;
  if (!['arm64', 'x64'].includes(arch) || !['friend', 'release'].includes(mode)) throw new Error('Expected arm64/x64 architecture and friend/release mode.');
  if (!version || !electronVersion) throw new Error('Expected app and Electron versions are required.');
  appPath = path.resolve(appPath);
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  if (!appPath.endsWith('.app') || !fs.existsSync(plist)) throw new Error(`App bundle not found: ${appPath}`);
  const readPlist = key => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]).trim();
  if (readPlist('CFBundleShortVersionString') !== version || readPlist('CFBundleVersion') !== version) throw new Error('App bundle version does not match the source version.');
  if (readPlist('CFBundleIdentifier') !== appId) throw new Error('Unexpected app bundle identifier.');
  const executableName = readPlist('CFBundleExecutable');
  if (!executableName || /[\\/\0\r\n]/.test(executableName) || executableName === '.' || executableName === '..') throw new Error('Invalid bundle executable name.');
  const executable = path.join(appPath, 'Contents', 'MacOS', executableName);
  run('/usr/bin/test', ['-x', executable]);
  const binaries = [...machOFiles(path.join(appPath, 'Contents', 'MacOS')), ...machOFiles(path.join(appPath, 'Contents', 'Frameworks'))];
  if (!binaries.includes(executable)) throw new Error('The app executable is not a Mach-O binary.');
  const expectedCPU = arch === 'arm64' ? 'arm64' : 'x86_64';
  for (const binary of binaries) {
    if (run('/usr/bin/lipo', ['-archs', binary]).trim() !== expectedCPU) throw new Error(`Wrong Mach-O architecture: ${binary}; expected ${expectedCPU}.`);
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', appPath]);
  const hardened = /^CodeDirectory .*flags=.*\bruntime\b/m.test(signature);
  if (mode === 'friend') {
    if (!/^Signature=adhoc\s*$/m.test(signature) || hardened) throw new Error('Friend builds require a complete ad-hoc bundle signature without hardened runtime.');
  } else {
    if (!/^Authority=Developer ID Application:/m.test(signature) || !/^TeamIdentifier=[A-Z0-9]{10}\s*$/m.test(signature) || !hardened) {
      throw new Error('Release requires Developer ID Application signing, a Team ID, and hardened runtime.');
    }
    run('/usr/bin/xcrun', ['stapler', 'validate', appPath]);
    run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  }
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: '1', LC_ALL: 'C' };
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_NO_ASAR']) delete environment[key];
  const probe = 'const p = require(process.argv[1]); console.log("VDC_MAC_SMOKE=" + JSON.stringify({version:p.version,name:p.name,electron:process.versions.electron,platform:process.platform,arch:process.arch}));';
  const output = run(executable, ['-e', probe, path.join(appPath, 'Contents', 'Resources', 'app.asar', 'package.json')], { env: environment });
  const marker = output.match(/^VDC_MAC_SMOKE=(.+)$/m);
  if (!marker) throw new Error('Packaged Electron executable did not complete its runtime smoke check.');
  const runtime = JSON.parse(marker[1]);
  if (runtime.version !== version || runtime.name !== 'visual-discord-code' || runtime.electron !== electronVersion || runtime.arch !== arch || runtime.platform !== 'darwin') throw new Error('Packaged runtime or ASAR does not match the expected app, Electron version, or architecture.');
  return { version, arch, mode, machOBinaries: binaries.length, bundleSignature: 'verified-deep-strict', notarized: mode === 'release', runtimeSmoke: runtime, guiLaunchTested: false };
}

if (require.main === module) {
  try {
    const manifest = require('../package.json');
    const [appPath, mode = 'release', arch = 'arm64', ...extra] = process.argv.slice(2);
    if (!appPath || extra.length) throw new Error('Usage: node scripts/verify-mac.cjs <app.app> [release|friend] [arm64|x64]');
    console.log(JSON.stringify(verifyMacApp(appPath, { mode, arch, version: manifest.version, electronVersion: manifest.devDependencies.electron }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { requireMac, runCommand, machOFiles, verifyMacApp };
