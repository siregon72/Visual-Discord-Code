'use strict';
const { IPC } = require('../shared/contracts');

function registerBridge({ ipcMain, window, isLocalPage, controller }) {
  function trusted(event) {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isLocalPage(event.senderFrame.url)) throw new Error('Untrusted sender');
  }
  const routes = [
    [IPC.action, value => controller.action(value), () => false],
    [IPC.open, value => controller.openConversation(value), () => ({ ok: false, error: '대화를 열지 못했습니다.' })],
    [IPC.send, value => controller.sendMessage(value), () => ({ ok: false, error: '전송 요청을 처리하지 못했습니다. 입력 내용은 그대로 남아 있습니다.' })],
    [IPC.history, value => controller.pageHistory(value), () => ({ ok: false })]
  ];
  for (const [channel, handle, failed] of routes) ipcMain.handle(channel, async (event, value) => {
    trusted(event);
    try { return await handle(value); } catch { return failed(); }
  });
  return () => { for (const [channel] of routes) ipcMain.removeHandler(channel); };
}
module.exports = { registerBridge };
