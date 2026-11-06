'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crc32, makeEntry, readZip, writeZip } = require('../scripts/mac-archive.cjs');

test('ZIP rewrite preserves executable modes, symlinks and original compressed records', () => {
  const executable = makeEntry('Visual Discord Code.app/Contents/MacOS/Visual Discord Code', 'binary', 0o100755);
  const link = makeEntry('Visual Discord Code.app/Contents/Frameworks/Test.framework/Versions/Current', 'A', 0o120777);
  const original = readZip(writeZip([executable, link]));
  const updated = readZip(writeZip([...original, makeEntry('README-macOS.txt', '한글 안내\n')]));
  assert.equal(updated[0].mode, 0o100755);
  assert.equal(updated[1].symlink, true);
  assert.equal(updated[1].data.toString(), 'A');
  assert.equal(updated[2].data.toString(), '한글 안내\n');
  for (let index = 0; index < original.length; index++) assert.deepEqual(updated[index].local, original[index].local);
});

test('ZIP CRC corruption and unsafe or duplicate paths are rejected', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zipped = writeZip([makeEntry('file', 'contents')]);
  const central = zipped.indexOf(Buffer.from('504b0102', 'hex'));
  zipped.writeUInt32LE(1234, central + 16);
  assert.throws(() => readZip(zipped), /CRC/);
  assert.throws(() => readZip(writeZip([makeEntry('../escape', 'bad')])) , /Unsafe/);
  assert.throws(() => readZip(writeZip([makeEntry('same', 'a'), makeEntry('same', 'b')])) , /duplicate/);
  assert.throws(() => readZip(Buffer.from('bad')), /end record/);
});
