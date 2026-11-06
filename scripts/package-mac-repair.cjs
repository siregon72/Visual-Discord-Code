'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readZip, makeEntry, writeZip, sha256 } = require('./mac-archive.cjs');
const appPrefix = 'Visual Discord Code.app/';

function packageRepair(input, output) {
  if (path.resolve(input) === path.resolve(output)) throw new Error('The original archive must be preserved.');
  const entries = readZip(fs.readFileSync(input));
  const appEntries = entries.filter(entry => entry.name.startsWith(appPrefix));
  const executable = appEntries.find(entry => entry.name === `${appPrefix}Contents/MacOS/Visual Discord Code`);
  if (!executable || executable.data.readUInt32LE(0) !== 0xfeedfacf || executable.data.readUInt32LE(4) !== 0x0100000c) throw new Error('Input must contain the Apple Silicon ARM64 app.');
  const asar = appEntries.find(entry => entry.name === `${appPrefix}Contents/Resources/app.asar`);
  if (!asar) throw new Error('App ASAR missing.');
  const files = appEntries.filter(entry => !entry.symlink && !entry.name.endsWith('/'));
  const symlinks = appEntries.filter(entry => entry.symlink);
  const binaries = files.filter(entry => entry.data.length >= 8 && entry.data.readUInt32LE(0) === 0xfeedfacf);
  for (const binary of binaries) {
    if (binary.data.readUInt32LE(4) !== 0x0100000c || !(binary.mode & 0o111)) throw new Error(`Wrong architecture/executable permissions: ${binary.name}`);
  }
  for (const link of symlinks) {
    const target = link.data.toString('utf8');
    if (/[\r\n\t\\]/.test(target) || target.startsWith('/') || !path.posix.normalize(path.posix.join(path.posix.dirname(link.name), target)).startsWith(appPrefix)) throw new Error(`Unsafe app symlink: ${link.name}`);
  }
  const header = JSON.parse(asar.data.subarray(16, 16 + asar.data.readUInt32LE(12)).toString('utf8'));
  const packageEntry = header.files?.['package.json'];
  if (!packageEntry || packageEntry.unpacked) throw new Error('Embedded package.json missing.');
  const packageStart = 8 + asar.data.readUInt32LE(4) + Number(packageEntry.offset);
  const version = JSON.parse(asar.data.subarray(packageStart, packageStart + packageEntry.size).toString('utf8')).version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Unexpected embedded app version.');
  const instructions = `Visual Discord Code ${version} — M 시리즈 Mac 최초 실행 수정본\n\n` +
    `대상: M1/M2/M3/M4/M5 등 Apple Silicon, macOS 13 이상.\n\n` +
    `1. ZIP을 Finder에서 모두 압축 해제하세요. 안의 파일들을 함께 두세요.\n` +
    `2. 터미널을 열고 /bin/bash 뒤에 공백 하나를 입력하세요.\n` +
    `3. First-Run.command 파일을 터미널 창에 끌어 놓고 Enter를 누르세요.\n` +
    `4. 파일 검사 → Mac 자체 도구로 로컬 서명 → 서명 검사 후 앱이 열립니다.\n` +
    `5. 이후에는 Visual Discord Code.app을 더블클릭하세요. 앱을 응용 프로그램 폴더로 옮겨도 됩니다.\n\n` +
    `First-Run.command를 처음부터 더블클릭하면 그 스크립트도 macOS가 차단할 수 있으므로 위 터미널 방법을 사용하세요.\n` +
    `기존 앱이 켜져 있으면 먼저 종료하세요. 실패하면 터미널의 오류 내용을 전달해주세요.\n\n` +
    `이 수정본은 Apple Developer ID 서명·공증 배포본이 아닙니다. 최초 실행은 위 절차가 필요합니다.\n` +
    `스크립트는 동봉된 앱 파일과 링크를 검사하고 그 앱만 로컬 재서명한 뒤 그 앱의 다운로드 격리 속성을 해제합니다.\n` +
    `관리자 권한이나 전체 Mac 보안 설정 변경은 요구하지 않습니다. 로그인 정보와 대화 데이터는 변경하지 않습니다.\n` +
    `Windows에서 ZIP CRC·ARM64·실행 권한·심볼릭 링크·원본 앱 데이터 일치를 검사했습니다. Mac 실기기 실행은 아직 확인하지 못했습니다.\n`;
  const additions = [
    makeEntry('README-macOS.txt', instructions),
    makeEntry('First-Run.command', fs.readFileSync(path.join(__dirname, 'macos-repair.sh'), 'utf8').replace(/\r\n/g, '\n'), 0o100755),
    makeEntry('macos-repair-manifest.txt', files.map(entry => `${sha256(entry.data)}  ${entry.name}\n`).join('')),
    makeEntry('macos-repair-symlinks.txt', symlinks.map(entry => `${entry.name}\t${entry.data.toString('utf8')}\n`).join(''))
  ];
  // Preserve Electron/Chromium license notices distributed beside the app.
  const preserved = entries.filter(entry => entry.name !== 'README-macOS.txt');
  const result = writeZip([...preserved, ...additions]);
  const verified = readZip(result);
  const byName = new Map(verified.map(entry => [entry.name, entry]));
  for (const original of preserved) {
    const final = byName.get(original.name);
    if (!final || !final.data.equals(original.data) || final.mode !== original.mode || !final.local.equals(original.local)) throw new Error(`Original app changed: ${original.name}`);
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, result, { flag: 'wx' });
  const report = {
    file: path.basename(output), sha256: sha256(result), bytes: result.length,
    original: { file: path.basename(input), sha256: sha256(fs.readFileSync(input)) },
    version, architecture: 'arm64', crcChecks: verified.length, appEntriesPreserved: appEntries.length,
    manifestFiles: files.length, symlinks: symlinks.length, arm64Executables: binaries.length, asarSha256: sha256(asar.data),
    firstRun: 'Local Mac ad-hoc signing and strict verification required before launch.',
    macExecutionTested: false, developerIdSigned: false, notarized: false
  };
  fs.writeFileSync(`${output}.verification.json`, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(path.dirname(output), 'SHA256SUMS.txt'), `${report.sha256}  ${report.file}\n`);
  return report;
}

if (require.main === module) {
  try {
    const [, , input, output] = process.argv;
    if (!input || !output) throw new Error('Usage: node scripts/package-mac-repair.cjs <original-AppleSilicon.zip> <new.zip>');
    console.log(JSON.stringify(packageRepair(path.resolve(input), path.resolve(output)), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { packageRepair };
