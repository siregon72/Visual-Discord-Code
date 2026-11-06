'use strict';

// ZIP32 reader/rewriter. Keep the original compressed app bytes, Unix modes,
// symlinks and extra fields when adding the first-run repair instructions.
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

function readZip(buffer) {
  if (buffer.length < 22) throw new Error('ZIP end record missing.');
  let end = buffer.length - 22;
  for (; end >= Math.max(0, buffer.length - 65557); end--) {
    if (buffer.readUInt32LE(end) === 0x06054b50 && end + 22 + buffer.readUInt16LE(end + 20) === buffer.length) break;
  }
  if (end < 0 || buffer.readUInt32LE(end) !== 0x06054b50) throw new Error('ZIP end record missing.');
  const count = buffer.readUInt16LE(end + 10);
  if (buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || count === 0xffff) throw new Error('Only single-disk ZIP32 is supported.');
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = [];
  const names = new Set();
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP central directory.');
    const length = 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    const central = Buffer.from(buffer.subarray(cursor, cursor + length));
    const name = central.subarray(46, 46 + central.readUInt16LE(28)).toString('utf8');
    if (!name || names.has(name) || name.startsWith('/') || /[\\\r\n\t]/.test(name) || name.split('/').includes('..')) throw new Error(`Unsafe/duplicate ZIP path: ${name}`);
    names.add(name);
    const flags = central.readUInt16LE(8);
    const method = central.readUInt16LE(10);
    if ((flags & 1) || ![0, 8].includes(method)) throw new Error(`Unsupported ZIP encoding: ${name}`);
    const offset = central.readUInt32LE(42);
    if (buffer.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Missing ZIP local entry: ${name}`);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const size = central.readUInt32LE(20);
    const compressed = buffer.subarray(start, start + size);
    const data = method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    if (data.length !== central.readUInt32LE(24) || crc32(data) !== central.readUInt32LE(16)) throw new Error(`ZIP CRC/size mismatch: ${name}`);
    let localEnd = start + size;
    if (flags & 8) localEnd += buffer.readUInt32LE(localEnd) === 0x08074b50 ? 16 : 12;
    const mode = central.readUInt32LE(38) >>> 16;
    entries.push({ name, mode, data, central, local: buffer.subarray(offset, localEnd), symlink: (mode & 0xf000) === 0xa000 });
    cursor += length;
  }
  if (cursor !== end || cursor - buffer.readUInt32LE(end + 16) !== buffer.readUInt32LE(end + 12)) throw new Error('ZIP central directory size mismatch.');
  return entries;
}

function makeEntry(name, data, mode = 0o100644) {
  const filename = Buffer.from(name, 'utf8');
  data = Buffer.from(data);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const local = Buffer.alloc(30 + filename.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(0x21, 12); // 1980-01-01, deterministic ZIP timestamp.
  local.writeUInt32LE(crc32(data), 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x314, 4); // Unix creator: retain executable/symlink modes.
  local.copy(central, 6, 4, 26);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE(((mode << 16) >>> 0), 38);
  filename.copy(central, 46);
  return { name, mode, data, local: Buffer.concat([local, compressed]), central, symlink: false };
}

function writeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const central = Buffer.from(entry.central);
    central.writeUInt32LE(offset, 42);
    locals.push(entry.local);
    centrals.push(central);
    offset += entry.local.length;
  }
  const directory = Buffer.concat(centrals);
  if (offset + directory.length >= 0xffffffff || entries.length >= 0xffff) throw new Error('ZIP32 size exceeded.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
module.exports = { crc32, readZip, makeEntry, writeZip, sha256 };
