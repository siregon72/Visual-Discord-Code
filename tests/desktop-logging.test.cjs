'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createFileLogger } = require('./helpers/file-logger.cjs');

const loggerModule = path.join(__dirname, 'helpers', 'file-logger.cjs');

function temporaryLog(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vdc-desktop-logging-'));
  const filename = path.join(directory, 'desktop.log');
  context.after(() => {
    if (fs.existsSync(filename)) fs.unlinkSync(filename);
    fs.rmdirSync(directory);
  });
  return { directory, filename };
}

test('desktop file logger appends formatted diagnostics and error stacks', context => {
  const { filename } = temporaryLog(context);
  const logger = createFileLogger(filename);
  logger.log('PASS: %s (%d)', '로컬 테스트', 2);
  const firstEntry = fs.readFileSync(filename, 'utf8');
  assert.ok(firstEntry.includes('PASS: 로컬 테스트 (2)'));

  logger.error('Fixture failure:', new Error('expected fixture failure'));
  logger.log('Final:', { completed: true });
  const contents = fs.readFileSync(filename, 'utf8');
  assert.ok(contents.startsWith(firstEntry), 'later diagnostics append without truncating earlier output');
  assert.match(contents, /Fixture failure: Error: expected fixture failure[\s\S]+\bat\b/);
  assert.ok(contents.includes('Final: { completed: true }'));
  assert.ok(contents.endsWith('\n'));
});

test('desktop file logger works when inherited stdout and stderr are closed', context => {
  const { filename } = temporaryLog(context);
  const childSource = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const uncaughtBefore = process.listenerCount('uncaughtException');
    const rejectionBefore = process.listenerCount('unhandledRejection');
    const stdout = process.stdout;
    const stderr = process.stderr;
    let streamWrites = 0;
    stdout.write = stderr.write = () => {
      streamWrites += 1;
      throw new Error('The file logger must not write to an output pipe');
    };
    fs.closeSync(1);
    fs.closeSync(2);
    const { createFileLogger } = require(process.argv[1]);
    const logger = createFileLogger(process.argv[2]);
    logger.log('PASS: %s', 'closed output pipes');
    logger.error(new Error('captured fixture failure'));
    assert.equal(streamWrites, 0);
    assert.equal(process.listenerCount('uncaughtException'), uncaughtBefore);
    assert.equal(process.listenerCount('unhandledRejection'), rejectionBefore);
  `;
  const result = spawnSync(process.execPath, ['-e', childSource, loggerModule, filename], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `Node-only closed-pipe probe exited with ${result.status}; signal=${result.signal}`);
  const contents = fs.readFileSync(filename, 'utf8');
  assert.ok(contents.includes('PASS: closed output pipes'));
  assert.ok(contents.includes('Error: captured fixture failure'));
});

test('desktop file logger surfaces filesystem failures instead of hiding them', context => {
  const { directory } = temporaryLog(context);
  assert.throws(() => {
    const logger = createFileLogger(directory);
    logger.error('This cannot be appended to a directory');
  }, error => ['EISDIR', 'EPERM', 'EACCES'].includes(error.code));
});

test('desktop file logger does not suppress an uncaught application exception', context => {
  const { filename } = temporaryLog(context);
  const childSource = `
    const { createFileLogger } = require(process.argv[1]);
    createFileLogger(process.argv[2]).log('before uncaught test exception');
    throw new Error('deliberate Node-only test exception');
  `;
  const result = spawnSync(process.execPath, ['-e', childSource, loggerModule, filename], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Error: deliberate Node-only test exception/);
  assert.ok(fs.readFileSync(filename, 'utf8').includes('before uncaught test exception'));
});
