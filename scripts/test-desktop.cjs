'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');

function report(descriptor, text) {
  try {
    fs.writeSync(descriptor, `${text}\n`);
  } catch (error) {
    // A terminal can close before a GUI test finishes. Only this optional
    // terminal summary may be dropped; complete results remain on disk.
    if (error.code !== 'EPIPE' && error.code !== 'EBADF') throw error;
  }
}

async function main() {
  const resultsRoot = path.join(root, 'test-results', 'live-desktop');
  fs.mkdirSync(resultsRoot, { recursive: true });
  const artifactDir = process.env.VDC_TEST_OUTPUT
    ? path.resolve(process.env.VDC_TEST_OUTPUT)
    : fs.mkdtempSync(path.join(resultsRoot, 'run-'));
  fs.mkdirSync(artifactDir, { recursive: true });
  const runnerLog = path.join(artifactDir, 'launcher.log');
  const writeLog = text => fs.appendFileSync(runnerLog, `${text}\n`, 'utf8');
  const electron = process.env.ELECTRON_EXEC_PATH || require('electron');
  const environment = { ...process.env, VDC_TEST_OUTPUT: artifactDir };
  delete environment.ELECTRON_RUN_AS_NODE;

  const descriptors = [];
  let child;
  try {
    descriptors.push(fs.openSync(path.join(artifactDir, 'stdout.log'), 'w'));
    descriptors.push(fs.openSync(path.join(artifactDir, 'stderr.log'), 'w'));
    child = spawn(electron, [path.join(root, 'tests', 'live-desktop.cjs')], {
      cwd: root,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', ...descriptors]
    });
  } finally {
    // The child inherits its own handles; the parent does not hold pipes open.
    for (const descriptor of descriptors) fs.closeSync(descriptor);
  }

  let interrupted = false;
  let timedOut = false;
  const stopChild = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const interrupt = () => {
    interrupted = true;
    stopChild();
  };
  process.once('exit', stopChild);
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const watchdog = setTimeout(() => {
    timedOut = true;
    stopChild();
  }, 60_000);

  let launchError;
  child.once('error', error => { launchError = error; });
  const { code, signal } = await new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(watchdog);
  process.removeListener('exit', stopChild);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);

  if (launchError) writeLog(launchError.stack || String(launchError));
  if (timedOut) writeLog('Desktop test exceeded the 60-second launcher timeout.');
  if (interrupted) writeLog('Desktop test interrupted by its launcher.');
  const exitCode = interrupted ? 130 : timedOut || launchError ? 1 : code ?? 1;
  writeLog(`Desktop test exited: code=${exitCode}, signal=${signal || 'none'}`);
  process.exitCode = exitCode;
  report(exitCode === 0 ? 1 : 2, `Desktop test ${exitCode === 0 ? 'passed' : 'failed'}. Logs: ${artifactDir}`);
}

main().catch(error => {
  process.exitCode = 1;
  report(2, error.stack || String(error));
});
