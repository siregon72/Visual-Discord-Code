'use strict';

const fs = require('node:fs');
const { format } = require('node:util');

// GUI tests can outlive their launcher's console. Diagnostics must never depend
// on inherited stdout/stderr pipes; keep genuine file errors visible to callers.
function createFileLogger(filename) {
  const write = (...values) => fs.appendFileSync(filename, `${format(...values)}\n`, 'utf8');
  return { log: write, error: write };
}

module.exports = { createFileLogger };
