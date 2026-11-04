'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLocalPageGuard } = require('../navigation');

test('local UI guard handles Electron portable-path URL spelling without broadening access', () => {
  const tempParent = fs.realpathSync(os.tmpdir());
  const tempRoot = fs.mkdtempSync(path.join(tempParent, 'vdc-local-page~ '));
  const pageDirectory = path.join(tempRoot, '앱 #100%');
  fs.mkdirSync(pageDirectory);
  const demoPage = path.join(pageDirectory, 'demo.html');
  const shellPage = path.join(pageDirectory, 'index.html');
  const unrelatedPage = path.join(pageDirectory, 'untrusted.html');
  for (const filename of [demoPage, shellPage, unrelatedPage]) fs.writeFileSync(filename, '<!doctype html><title>test</title>');

  try {
    const accepts = createLocalPageGuard([demoPage, shellPage]);
    const encodedDemoURL = pathToFileURL(demoPage).href;
    const chromiumDemoURL = encodedDemoURL.replace(/%7e/gi, '~');

    // Node's pathToFileURL escapes ~ while Chromium's loadFile URL preserves it.
    assert.equal(accepts(encodedDemoURL), true, 'Node-encoded portable path');
    assert.equal(accepts(chromiumDemoURL), true, 'Chromium literal tilde in portable path');
    assert.equal(accepts(pathToFileURL(shellPage).href), true, 'second authorized local page');
    assert.equal(accepts(encodedDemoURL.replace(/%[0-9A-F]{2}/g, escape => escape.toLowerCase())), true, 'equivalent percent-escape casing');
    if (process.platform === 'win32') assert.equal(accepts(chromiumDemoURL.toUpperCase()), true, 'Windows path casing');

    assert.equal(accepts(pathToFileURL(unrelatedPage).href), false, 'existing sibling file is not authorized');
    assert.equal(accepts(pathToFileURL(path.join(pageDirectory, 'missing.html')).href), false, 'nonexistent file');
    assert.equal(accepts(encodedDemoURL + '?next=index.html'), false, 'query must not alter trusted page identity');
    assert.equal(accepts(encodedDemoURL + '#section'), false, 'fragment is not an approved page URL');
    assert.equal(accepts('https://discord.com/login'), false, 'remote page');
    assert.equal(accepts('https://example.com/demo.html'), false, 'matching filename on remote host');
    assert.equal(accepts('file://untrusted.example/demo.html'), false, 'remote file host');
    assert.equal(accepts('javascript:alert(1)'), false, 'executable URL');
    assert.equal(accepts('not a URL'), false, 'malformed input');
    assert.equal(accepts(encodedDemoURL.replace('demo.html', '%2Fdemo.html')), false, 'encoded path separator');
  } finally {
    // Verify the generated cleanup target is still the exact temporary child we created.
    const resolvedRoot = fs.realpathSync(tempRoot);
    assert.equal(path.dirname(resolvedRoot).toLowerCase(), tempParent.toLowerCase());
    assert.ok(path.basename(resolvedRoot).startsWith('vdc-local-page~ '));
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
});
