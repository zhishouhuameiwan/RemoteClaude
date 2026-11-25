'use strict';
// 只把被控端页面需要的几个调用暴露出去，页面本身拿不到 Node 和 Electron 的其它能力
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rc', {
  getConfig: () => ipcRenderer.invoke('rc:config'),
  getAccount: () => ipcRenderer.invoke('rc:account'),
  getToken: () => ipcRenderer.invoke('rc:token'),
  login: (email, password) => ipcRenderer.invoke('rc:login', email, password),
  logout: () => ipcRenderer.invoke('rc:logout'),
  // 设置或更换服务器：地址在主进程里整理和检查，返回 { server, changed } 或 { error }
  setServer: (input) => ipcRenderer.invoke('rc:set-server', String(input)),
  // 托盘菜单点了"更换服务器…"
  onEditServer: (cb) => ipcRenderer.on('rc:edit-server', () => cb()),
  sessionInvalid: () => ipcRenderer.invoke('rc:session-invalid'),
  openAccountPage: (which) => ipcRenderer.invoke('rc:open-account-page', which),
  // opts.thumbs 为 false 时不截缩略图，马上就回
  listWindows: (opts) => ipcRenderer.invoke('rc:list', opts),
  prepareCapture: (hwnd) => ipcRenderer.invoke('rc:prepare', hwnd),
  input: (viewerId, hwnd, ev) => ipcRenderer.send('rc:input', viewerId, hwnd, ev),
  release: (viewerId) => ipcRenderer.send('rc:release', viewerId),
  pasteImage: (viewerId, hwnd, bytes) => ipcRenderer.invoke('rc:paste-image', viewerId, hwnd, bytes),
  fileBegin: (viewerId, id, name, size) => ipcRenderer.invoke('rc:file-begin', viewerId, id, name, size),
  fileData: (viewerId, id, bytes) => ipcRenderer.send('rc:file-data', viewerId, id, bytes),
  fileAbort: (viewerId) => ipcRenderer.send('rc:file-abort', viewerId),
  fileEnd: (viewerId, id, sha256, hwnd) => ipcRenderer.invoke('rc:file-end', viewerId, id, sha256, hwnd),
  getLockState: () => ipcRenderer.invoke('rc:lock-state'),
  getTileState: () => ipcRenderer.invoke('rc:tile-state'),
  tile: (op) => ipcRenderer.invoke('rc:tile', op),
  onTileState: (cb) => ipcRenderer.on('rc:tile-state', (_e, state) => cb(state)),
  getUpdateState: () => ipcRenderer.invoke('rc:update-state'),
  update: (op) => ipcRenderer.invoke('rc:update', op),
  onUpdateState: (cb) => ipcRenderer.on('rc:update-state', (_e, state) => cb(state)),
  getApprovals: () => ipcRenderer.invoke('rc:approvals'),
  answerApproval: (id, ans) => ipcRenderer.invoke('rc:approval-answer', id, ans),
  onApprovals: (cb) => ipcRenderer.on('rc:approvals', (_e, list) => cb(list)),
  listSessions: () => ipcRenderer.invoke('rc:sessions'),
  openSession: (id) => ipcRenderer.invoke('rc:open-session', id),
  newSession: (envId) => ipcRenderer.invoke('rc:new-session', envId),
  closeWindow: (hwnd, title) => ipcRenderer.invoke('rc:close-window', hwnd, title),
  windowState: (hwnd) => ipcRenderer.invoke('rc:window-state', hwnd),
  lockNow: () => ipcRenderer.invoke('rc:lock-now'),
  unlock: (password) => ipcRenderer.invoke('rc:unlock', password),
  onLockState: (cb) => ipcRenderer.on('rc:lock-state', (_e, state) => cb(state)),
  getHostKey: () => ipcRenderer.invoke('rc:host-key'),
  onHostKey: (cb) => ipcRenderer.on('rc:host-key', (_e, key) => cb(key)),
  unlockEnc: (enc) => ipcRenderer.invoke('rc:unlock-enc', enc),
  setActive: (count) => ipcRenderer.send('rc:active', count),
  setStatus: (kind, text) => ipcRenderer.send('rc:status', kind, text),
  onInputError: (cb) => ipcRenderer.on('rc:input-error', (_e, viewerId, code, detail) => cb(viewerId, code, detail)),
  // 电脑上新复制的文字，已经整理成要发给控制端的消息（协议文档 4.9）
  onClipboard: (cb) => ipcRenderer.on('rc:clipboard', (_e, msgs) => cb(msgs)),
});
