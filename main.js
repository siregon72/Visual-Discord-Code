'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { isDiscordURL, isExternalURL, createLocalPageGuard } = require('./navigation');
const { transmitMessage } = require('./send-message');
const { createController } = require('./src/main/controller');
const { registerBridge } = require('./src/main/ipc');
const { configurePermissions } = require('./src/main/permissions');

if (process.env.VDC_TEST_PROFILE) app.setPath('userData', path.resolve(process.env.VDC_TEST_PROFILE));
const ownsLock = app.requestSingleInstanceLock();
let window = null, controller = null, unregisterBridge = null;

function dispose() {
  controller?.dispose(); controller = null;
  unregisterBridge?.(); unregisterBridge = null;
}

async function start() {
  if (process.platform === 'win32') app.setAppUserModelId('local.visualdiscordcode.desktop');
  nativeTheme.themeSource = 'dark';
  const guestSession = session.fromPartition('persist:visual-discord-code');
  configurePermissions({ guestSession, defaultSession: session.defaultSession, isDiscordURL, dialog, getWindow: () => window });
  window = new BrowserWindow({ width: 1440, height: 940, minWidth: 880, minHeight: 600, backgroundColor: '#1e1e1e', frame: false,
    show: false, title: 'Visual Discord Code', icon: path.join(__dirname, 'assets', 'app-icon.ico'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  controller = createController({ window, guestSession, dialog, isDiscordURL, transmitMessage,
    adapterSource: fs.readFileSync(path.join(__dirname, 'discord-adapter.js'), 'utf8'),
    openExternal: url => { if (isExternalURL(url)) shell.openExternal(url).catch(() => {}); },
    createGuest: () => new WebContentsView({ webPreferences: { session: guestSession, nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, backgroundThrottling: false, spellcheck: true } }) });
  unregisterBridge = registerBridge({ ipcMain, window, isLocalPage: createLocalPageGuard([path.join(__dirname, 'live.html')]), controller });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('before-input-event', controller.shortcuts);
  window.on('resize', controller.layout);
  window.on('closed', () => { dispose(); window = null; });
  await window.loadFile(path.join(__dirname, 'live.html'));
  if (window && !window.isDestroyed() && controller) { window.show(); controller.start(); }
}

if (!ownsLock) app.quit();
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', dispose);
  app.on('window-all-closed', () => app.quit());
  app.whenReady().then(start).catch(() => {
    dispose();
    dialog.showErrorBox('Visual Discord Code', '앱 화면을 시작하지 못했습니다. 실행 파일을 다시 열어주세요.');
    app.quit();
  });
}
