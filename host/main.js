'use strict';
/**
 * RemoteClaude 被控端（Electron 主进程）
 *
 * 分工：
 *   - 渲染进程 renderer.js：连接信令服务器、按窗口采集画面、通过 WebRTC 推流
 *   - 主进程（本文件）：枚举 Claude 窗口、生成缩略图、把远程输入注入到选中的窗口
 */
const {
  app,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  powerSaveBlocker,
  powerMonitor,
  clipboard,
  shell,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  ClipboardItem,
  dialog,
} = require('electron');
const fs = require('fs');
const path = require('path');
const win32 = require('./win32');
const { Account, AUTH_FILE } = require('./account');
const serverAddress = require('./serveraddress');
const files = require('./files');
const { isClosable } = require('./sessions');
const { sortByPosition } = require('./winorder');
const { createLogFile, teeConsole } = require('./logfile');
const { createClipWatch } = require('./clipwatch');
const { createFrontBlock } = require('./frontblock');

const MAX_TEXT = 20000;

// 用户数据目录（登录状态、设备编号）固定为 %APPDATA%\remote-claude-host，开发版和装好的正式版共用，
// 换成安装版不用重新登录，也还是同一台电脑。两个同时启动时，后启动的会因为单实例锁退出。
// 开发测试用：RC_HOST_PROFILE 指定另一个数据目录，就能在同一台电脑上再跑一个被控端，
// 它有自己的登录状态和设备编号（相当于另一台电脑），单实例锁也按目录分开
app.setPath(
  'userData',
  process.env.RC_HOST_PROFILE ? path.resolve(process.env.RC_HOST_PROFILE) : path.join(app.getPath('appData'), 'remote-claude-host')
);

// 日志同时写进 <用户数据目录>\logs\host.log：正式版的控制台没人看，出了问题要靠这个文件查
teeConsole(createLogFile(path.join(app.getPath('userData'), 'logs', 'host.log')));
console.log(`被控端 ${app.getVersion()} 启动（进程 ${process.pid}）`);

/**
 * 配置文件：开发版是 host/config.json；装好的正式版在用户数据目录里，没有就全用默认值。
 * 服务器地址（server）也在这里：在窗口里填或改了会写回这个文件（只改 server，别的设置不动）
 */
const CONFIG_PATH =
  process.env.RC_HOST_CONFIG || (app.isPackaged ? path.join(app.getPath('userData'), 'config.json') : path.join(__dirname, 'config.json'));

function loadConfig() {
  let raw;
  try {
    raw = serverAddress.readConfig(CONFIG_PATH);
  } catch (err) {
    const msg = `读取配置失败: ${CONFIG_PATH}\n${err.message}\n改好或删掉这个文件后重新打开。`;
    console.error(msg);
    // 装好的正式版没有控制台，不弹个框的话双击了什么反应都没有
    if (app.isPackaged) dialog.showErrorBox('RemoteClaude 被控端', msg);
    process.exit(1);
  }
  const cfg = {
    targets: (Array.isArray(raw.targets) && raw.targets.length ? raw.targets : ['claude.exe']).map((s) => String(s).toLowerCase()),
    // 默认值见 docs/05 的 2.14：满屏文字滚动时 VP8 一帧要 90KB 上下，VP9 同样带宽下能稳定 30 帧
    maxBitrateKbps: Number(raw.maxBitrateKbps) || 10000,
    maxFps: Number(raw.maxFps) || 30,
    // 连接一开始的带宽估计（默认 300kbps 太低，见 sdp.js），不超过码率上限
    startBitrateKbps: Number(raw.startBitrateKbps) || 2500,
    codec: String(raw.codec || 'VP9'),
    // 控制端发来的文件存在这里（协议文档 4.8）。放在"下载"里，电脑前的人好找，也不受 Claude 商店版转向 AppData 的影响
    fileDir: raw.fileDir ? path.resolve(String(raw.fileDir)) : path.join(app.getPath('downloads'), 'RemoteClaude'),
    // 有人看画面时，把电脑上新复制的文字发给控制端（协议文档 4.9）。写成 false 可以关掉
    clipboardSync: raw.clipboardSync !== false,
    // Claude 桌面端升级后，电脑空闲时自动试一遍打开和新建会话（docs/07 第 8 节）。写成 false 可以关掉
    claudeSelfCheck: raw.claudeSelfCheck !== false,
    // Claude 桌面端自己弹的确认框（"允许 Claude 操作这个网站？"等）提醒到手机（docs/09 第 4 节）。写成 false 可以关掉
    dialogNotice: raw.dialogNotice !== false,
    // Claude 桌面端的日志文件，不写就自己找
    claudeLogFile: raw.claudeLogFile ? path.resolve(String(raw.claudeLogFile)) : '',
  };
  if (raw.hostToken) console.warn('提示: hostToken 已不再使用，被控端改为用账号登录，可以从配置里删掉。');
  return { cfg, configuredServer: raw.server };
}

const loaded = loadConfig();
const cfg = loaded.cfg;
/**
 * 现在连的服务器。安装包里不带地址（docs/08 第 1 节）：配置文件里没写 server 时，从上次的登录状态找回
 * （旧版安装包升级上来的情况，见 serveraddress.js 的 resolveServer），都没有就空着，窗口里显示登录页让用户填。
 *   url     整理好的 ws:// 或 wss:// 地址，没设置时为空
 *   input   登录页地址框里预填的内容
 *   notice  给用户看的问题说明（比如配置文件里的地址写错了）
 *   migrate 地址是从登录状态找回的，启动后要写进配置文件
 */
const serverState = (() => {
  const r = serverAddress.resolveServer({
    configured: loaded.configuredServer,
    accountServer: serverAddress.readAccountServer(path.join(app.getPath('userData'), AUTH_FILE)),
  });
  if (r.error) console.error(`${r.error}（${CONFIG_PATH}）`);
  return { url: r.server, input: r.input, notice: r.error, migrate: r.source === 'account' };
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 被控端窗口经常在后台或被挡住，不能让 Chromium 因此降频，否则画面会卡
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// 第二项：Chromium 默认把本机局域网 IP 藏成 mDNS 的 .local 名字，浏览器能解析，
// 安卓 App 用的 WebRTC 原生库解析不了，结果同一个 Wi-Fi 下也直连不上、只能绕道中继。
// 被控端是自己的程序，ICE 候选只发给自己的控制端，不需要隐藏。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,WebRtcHideLocalIpsWithMdns');

// 同一个数据目录只能跑一个被控端（比如开发版在跑时又打开了安装版）：后启动的直接退出，什么都不做
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Account | null} */
let account = null;
/** @type {Tray | null} */
let tray = null;
/** 只有从托盘菜单选"退出"（或系统关机）才真正退出；点窗口的关闭按钮只是藏到托盘 */
let quitting = false;
let trayHintShown = false;
const trayState = { online: false, status: '正在启动…', viewers: 0 };

const asset = (name) => path.join(__dirname, 'assets', name);

function showWindow() {
  // 窗口万一被销毁了（不是经关闭按钮），重新建一个；页面会自动重连
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTray() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromPath(asset(trayState.online ? 'tray-on.png' : 'tray-off.png')));
  const watching = trayState.viewers > 0 ? `\n${trayState.viewers} 个设备正在查看` : '';
  // 系统限制提示文字最长 127 个字符
  tray.setToolTip(`RemoteClaude 被控端\n${trayState.status}${watching}`.slice(0, 127));
}

/**
 * 托盘菜单“屏幕顺序”的子菜单：先往哪个屏放 Claude 窗口，点一下就写进平铺配置并马上重排。
 * 前面是按位置的排法（从左到右等），屏不多时后面再列出按屏幕序号的所有排法（屏 2 → 3 → 1 这种）。
 * 用打勾的项而不是单选项：单选项被分隔线隔成两组后，系统会给没选中的那一组也勾上第一项。
 */
function tileOrderItems() {
  return tiler.monitorOrderChoices().map((c) => {
    if (c.separator) return { type: 'separator' };
    return {
      // 屏太多、没列出排法时，配置文件里自己指定的顺序只能在配置文件里改，点它就打开配置文件
      label: c.custom ? `${c.label}（在配置文件里改）` : c.label,
      type: 'checkbox',
      checked: c.checked,
      click: () => (c.custom ? shell.openPath(tiler.configPath) : setTileOrder(c.value)),
    };
  });
}

function setTileOrder(order) {
  if (!tiler) return;
  if (!tiler.setMonitorOrder(order) && tray) {
    tray.displayBalloon({
      iconType: 'warning',
      title: '屏幕顺序没改成',
      content: '平铺配置文件里有写错的地方，或者写不进去。可以从托盘菜单“打开平铺配置文件”看一下。',
    });
  }
  refreshTrayMenu(); // 没改成、或者点的就是现在这一项时，把菜单上的勾恢复成配置里实际的样子
}

function trayMenu() {
  let tileItems = [];
  if (tiler) {
    tileItems = [
      { label: '立即重排 Claude 窗口', click: () => tiler.arrange('托盘菜单') },
      { label: '把所有 Claude 会话提到最前', click: () => tiler.raiseAll() },
      { label: '暂停自动平铺', type: 'checkbox', checked: tiler.paused, click: (item) => tiler.setPaused(item.checked) },
      { label: '屏幕顺序（先往哪个屏放）', submenu: tileOrderItems() },
      { label: '打开平铺配置文件', click: () => shell.openPath(tiler.configPath) },
      { type: 'separator' },
    ];
  } else if (tilerBlocked) {
    tileItems = [{ label: '窗口平铺：旧的平铺插件还在运行，没有启用', enabled: false }, { type: 'separator' }];
  }
  return Menu.buildFromTemplate([
    { label: '显示窗口', click: showWindow },
    { label: '更换服务器…', click: editServer },
    { type: 'separator' },
    ...tileItems,
    ...updateMenuItems(),
    {
      label: '退出 RemoteClaude',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

/** 托盘菜单"更换服务器…"：打开窗口，让页面显示改地址的输入框（没登录时就是登录页的地址框） */
function editServer() {
  showWindow();
  const wc = mainWindow && mainWindow.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send('rc:edit-server'));
  else wc.send('rc:edit-server');
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(trayMenu());
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(asset('tray-off.png')));
  tray.setContextMenu(trayMenu());
  // Windows 上单击托盘图标打开窗口，右键出菜单
  tray.on('click', showWindow);
  updateTray();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 680,
    title: 'RemoteClaude 被控端',
    icon: asset('icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  // 启动时不抢焦点，免得打断正在用电脑的人
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.showInactive());
  // 这个窗口只显示本地页面，禁止跳转和新开窗口
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 关闭按钮只把窗口藏到托盘：页面继续运行，远程连接不受影响
  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({
        iconType: 'info',
        title: 'RemoteClaude 仍在运行',
        content: '已最小化到托盘，远程查看不受影响。要退出请右键托盘图标。',
      });
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  persistMigratedServer();
  account = new Account(serverState.url);
  setupAutoStart();
  createUpdater();
  approvals.start();
  createTray();
  createWindow();
  setInterval(pollLock, LOCK_POLL_MS);
  pollLock();
  startTiler();
  // Claude 升级后自检。开发测试时另起的第二个被控端（RC_HOST_PROFILE）不做，免得两个一起动 Claude 的窗口
  if (cfg.claudeSelfCheck && (!process.env.RC_HOST_PROFILE || process.env.RC_CLAUDE_CHECK)) {
    setInterval(() => {
      claudeCheck.tick().catch((err) => console.error('自检出错:', err));
    }, CLAUDE_CHECK_TICK_MS);
  }
  // 桌面端自己弹的确认框提醒手机。另起的第二个被控端同样不做，免得同一个框提醒两遍
  if (cfg.dialogNotice && (!process.env.RC_HOST_PROFILE || process.env.RC_DIALOG_WATCH)) {
    setInterval(() => {
      try {
        dialogWatch.tick();
      } catch (err) {
        console.error('确认框提醒出错:', err);
      }
    }, dialogWatchLib.TICK_MS);
  }
  // 上次没收完就退出了留下的临时文件
  fileReceiver.cleanupStale();
  console.log('收到的文件存在 ' + cfg.fileDir);
});

app.on('will-quit', () => {
  if (!gotLock || !app.isReady()) return;
  globalShortcut.unregisterAll();
  if (tiler) tiler.stop();
  approvals.stop();
});
// 已经在运行时再次启动（比如又双击了快捷方式）：把藏在托盘里的窗口显示出来
app.on('second-instance', showWindow);
// 系统关机、注销时也要能退出，不能被"藏到托盘"拦住
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

/**
 * 从旧版升级上来、配置文件里没有 server 时，把从登录状态找回的地址写进配置文件，以后启动就不再依赖登录状态。
 * 写不进去也照样用这个地址连，下次启动再试
 */
function persistMigratedServer() {
  if (!serverState.migrate) return;
  try {
    serverAddress.saveServer(CONFIG_PATH, serverState.url);
    serverState.migrate = false;
    console.log(`配置里没有服务器地址，按上次登录的服务器补上: ${serverAddress.displayOf(serverState.url)}（${CONFIG_PATH}）`);
  } catch (err) {
    console.error(`把服务器地址写进配置文件失败（这次照样连 ${serverState.url}）: ${err.message}`);
  }
}

// 页面把连接状态告诉主进程，用来更新托盘图标和提示文字
ipcMain.on('rc:status', (e, kind, text) => {
  if (!mainWindow || e.sender !== mainWindow.webContents) return;
  trayState.online = kind === 'on';
  trayState.status = String(text || '').slice(0, 60);
  updateTray();
});

// ---------------------------------------------------------------- 窗口列表与采集准备

ipcMain.handle('rc:config', () => ({
  server: serverState.url,
  // 界面上显示和预填的是简写（rc.example.com），和手机 App 填的一样
  serverDisplay: serverAddress.displayOf(serverState.url),
  serverInput: serverState.url ? serverAddress.displayOf(serverState.url) : serverState.input,
  serverNotice: serverState.notice,
  targets: cfg.targets,
  maxBitrateKbps: cfg.maxBitrateKbps,
  maxFps: cfg.maxFps,
  startBitrateKbps: Math.min(cfg.startBitrateKbps, cfg.maxBitrateKbps),
  codec: cfg.codec,
  fileMax: files.FILE_MAX,
  version: app.getVersion(),
}));

// ---------------------------------------------------------------- 账号

const fromOwnWindow = (e) => !!mainWindow && e.sender === mainWindow.webContents;

ipcMain.handle('rc:account', (e) => {
  if (!fromOwnWindow(e)) return null;
  return {
    loggedIn: !!account.state,
    email: account.state ? account.state.email : null,
    deviceName: account.deviceName,
    httpBase: account.httpBase,
  };
});

/**
 * 设置或更换服务器（登录页的地址框、登录后的"更换服务器"）。地址在主进程里整理和检查，只接受 ws:// 和 wss://；
 * 写进配置文件后退出旧服务器上的登录（通知旧服务器作废令牌），换成新服务器，页面接着显示登录页。
 * 返回 { server, changed } 或 { error }
 */
async function setServer(input) {
  let url;
  try {
    url = serverAddress.wsUrlOf(input);
  } catch (err) {
    return { error: err.message };
  }
  if (!url) return { error: '请填写服务器地址' };
  if (!/^wss?:\/\/[^\s]+$/.test(url)) return { error: '服务器地址必须是 ws:// 或 wss:// 地址' };
  if (url === serverState.url) return { server: url, changed: false };
  try {
    serverAddress.saveServer(CONFIG_PATH, url);
  } catch (err) {
    return { error: `服务器地址没保存上：${err.message}` };
  }
  // logout() 先同步清掉本地登录状态、再去通知旧服务器，所以下面新建的 Account 读不到旧令牌
  const loggingOut = account.logout();
  account = new Account(url);
  Object.assign(serverState, { url, input: url, notice: '', migrate: false });
  console.log(`服务器地址改为 ${serverAddress.displayOf(url)}（已写进 ${CONFIG_PATH}）`);
  await loggingOut;
  return { server: url, changed: true };
}

ipcMain.handle('rc:set-server', (e, input) => {
  if (!fromOwnWindow(e) || typeof input !== 'string' || input.length > serverAddress.MAX_LENGTH) return { error: '参数不对' };
  return setServer(input);
});

ipcMain.handle('rc:token', (e) => (fromOwnWindow(e) && account.state ? account.state.token : null));

ipcMain.handle('rc:login', async (e, email, password) => {
  if (!fromOwnWindow(e) || typeof email !== 'string' || typeof password !== 'string') return { error: '参数不对' };
  return account.login(email.trim(), password);
});

ipcMain.handle('rc:logout', async (e) => {
  if (fromOwnWindow(e)) await account.logout();
});

// 服务器说令牌已失效（被作废或过期）：清掉本地登录状态
ipcMain.handle('rc:session-invalid', (e) => {
  if (fromOwnWindow(e)) account.clear();
});

// 注册和找回密码在网页上完成，用系统浏览器打开
ipcMain.handle('rc:open-account-page', (e, which) => {
  if (!fromOwnWindow(e) || !['register', 'forgot'].includes(which) || !account.httpBase) return;
  shell.openExternal(`${account.httpBase}/#${which}`);
});

/** Electron 的窗口采集源 id 形如 "window:<HWND>:0" */
const sourceIdOf = (hwnd) => `window:${hwnd}:0`;

/**
 * 给目标窗口截缩略图。getSources 会给电脑上所有窗口各截一张（没法只截某几个），实测十个窗口要 0.6 秒左右，
 * 所以列表可以不等它（见 rc:list 的 opts.thumbs）
 */
async function captureThumbs() {
  const thumbs = new Map();
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 360, height: 360 },
      fetchWindowIcons: false,
    });
    for (const s of sources) {
      const hwnd = Number(s.id.split(':')[1]);
      if (hwnd && s.thumbnail && !s.thumbnail.isEmpty()) {
        thumbs.set(hwnd, 'data:image/jpeg;base64,' + s.thumbnail.toJPEG(70).toString('base64'));
      }
    }
  } catch (err) {
    console.error('生成缩略图失败:', err.message);
  }
  return thumbs;
}

/**
 * 给控制端的窗口列表，按窗口在屏幕上的位置排（winorder.js，协议文档 2.4）：屏的先后跟平铺配置走，同屏从左到右。
 * 系统枚举出来是最近操作过的在最前，手机上点进哪个窗口它就跑到第一个，所以不能直接用。
 * 取显示器出了错就只按从左到右排，不能因此回不了列表
 */
function listTargetWindows() {
  let monitors = [];
  try {
    monitors = require('./tiler').orderedMonitors();
  } catch (err) {
    console.error('取显示器顺序失败，窗口列表只按从左到右排:', err.message);
  }
  return sortByPosition(win32.enumTargetWindows(cfg.targets), monitors);
}

// opts.thumbs 为 false 时不截缩略图（thumb 全是 null），枚举窗口只要几毫秒：
// 控制端先拿这份把标题、个数显示出来，带图的那份随后再要（winlist.js，协议文档 2.4）
ipcMain.handle('rc:list', async (_e, opts) => {
  const wins = listTargetWindows();
  const thumbs = opts && opts.thumbs === false ? new Map() : await captureThumbs();
  return wins.map((w) => ({
    hwnd: w.hwnd,
    title: w.title,
    minimized: w.minimized,
    width: w.width,
    height: w.height,
    thumb: thumbs.get(w.hwnd) || null,
    // 0.9.1 起：控制端能不能关这个窗口（Claude 主窗口不能，协议文档 2.8）
    closable: isClosable(w),
  }));
});

ipcMain.handle('rc:prepare', async (_e, hwnd) => {
  hwnd = Number(hwnd);
  if (!Number.isInteger(hwnd) || !win32.isTargetWindow(hwnd, cfg.targets)) {
    throw new Error('not-a-target');
  }
  if (win32.restoreIfMinimized(hwnd)) await sleep(400); // 等还原动画结束，否则第一帧是空的
  const b = win32.frameBounds(hwnd);
  return { sourceId: sourceIdOf(hwnd), title: win32.windowTitle(hwnd), width: b ? b.width : 0, height: b ? b.height : 0 };
});

// 有人在看的时候不让显示器休眠（锁屏或息屏后既采集不到画面也注入不了输入）。
// 防休眠只能拦着不关，显示器已经关着时叫不醒，所以有人开始看时先动一下鼠标把它叫醒：
// 息屏时 Claude 的窗口不刷新画面，手机上看到的会一直是息屏前的样子
let blockerId = null;
ipcMain.on('rc:active', (_e, count) => {
  trayState.viewers = Math.max(0, Number(count) || 0);
  updateTray();
  // 等没人看画面了再重启换新版本
  if (trayState.viewers === 0 && updater) updater.maybeInstall();
  if (count > 0 && blockerId === null) {
    win32.wakeDisplay();
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
  } else if (count <= 0 && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
  // 只在有人看画面的时候盯着剪贴板
  if (cfg.clipboardSync) {
    if (trayState.viewers > 0) clipWatch.start();
    else clipWatch.stop();
  }
});

// ---------------------------------------------------------------- 剪贴板回传（协议文档 4.9）

/** 电脑上新复制的文字交给页面，页面经数据通道发给正在看画面的控制端 */
const clipWatch = createClipWatch({
  seq: win32.clipboardSeq,
  hasText: win32.clipboardHasText,
  excluded: win32.clipboardExcluded,
  locked: win32.isLocked,
  readText: () => clipboard.readText(),
  emit: (msgs) => {
    if (mainWindow) mainWindow.webContents.send('rc:clipboard', msgs);
  },
  log: (msg) => console.log('[剪贴板] ' + msg),
});

// ---------------------------------------------------------------- 输入注入

/** viewerId -> 该控制端当前按住的鼠标键集合，断线时用来松开 */
const held = new Map();
const lastErrorAt = new Map();
let chain = Promise.resolve(); // 所有输入事件串行执行，保证顺序
/** 切不到前台时记下挡在最前面的是谁：写日志，给控制端的提示补一句说明 */
const frontBlock = createFrontBlock({
  log: (line) => console.log(line),
  selfElevated: win32.processElevation(process.pid) === 'elevated',
});

/** 切不到前台时，分清是电脑锁屏了还是别的原因 */
function frontFailure() {
  return win32.isLocked() ? 'locked' : 'front-failed';
}

function reportError(viewerId, code) {
  if (code === 'front-failed') code = frontFailure();
  const now = Date.now();
  const key = viewerId + ':' + code;
  if (now - (lastErrorAt.get(key) || 0) < 1500) return;
  lastErrorAt.set(key, now);
  // 切不到前台时补一句是谁挡在最前面（协议文档第 5 节的 detail）
  const detail = code === 'front-failed' ? frontBlock.detail() : null;
  if (mainWindow) mainWindow.webContents.send('rc:input-error', viewerId, code, detail);
}

/**
 * 确保目标窗口在前台；切换后稍等片刻让系统完成激活。
 * 切不过去、电脑又没锁屏时，记下挡在最前面的是谁（锁屏时切不过去是锁屏的缘故，不记）
 */
async function ensureFront(hwnd) {
  if (win32.isFront(hwnd)) return true;
  // 这是为远程输入切的前台，不要触发平铺的"把所有会话窗口提到最前"
  if (tiler) tiler.ignoreActivation();
  if (win32.bringToFront(hwnd)) {
    await sleep(60);
    if (win32.isFront(hwnd)) return true;
  }
  if (!win32.isLocked()) frontBlock.note(win32.foregroundInfo());
  return false;
}

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

async function handleInput(viewerId, hwnd, ev) {
  if (!ev || typeof ev !== 'object' || typeof ev.t !== 'string') return;
  hwnd = Number(hwnd);
  if (!Number.isInteger(hwnd) || !win32.isTargetWindow(hwnd, cfg.targets)) {
    reportError(viewerId, 'window-gone');
    return;
  }

  switch (ev.t) {
    case 'm': {
      // 只移动指针不抢前台：目标不在前台、或落点被别的窗口挡住时直接忽略
      if (!isFiniteNum(ev.x) || !isFiniteNum(ev.y) || !win32.isFront(hwnd)) return;
      const pt = win32.toScreen(hwnd, ev.x, ev.y);
      if (pt && win32.pointHitsWindow(pt, hwnd)) win32.sendInputs([win32.mouseInput(pt, 0, 0)]);
      return;
    }
    case 'd': {
      const b = ev.b | 0;
      if (b < 0 || b > 2 || !isFiniteNum(ev.x) || !isFiniteNum(ev.y)) return;
      if (!(await ensureFront(hwnd))) return reportError(viewerId, 'front-failed');
      const pt = win32.toScreen(hwnd, ev.x, ev.y);
      if (!pt || !win32.pointHitsWindow(pt, hwnd)) return reportError(viewerId, 'covered');
      win32.sendInputs([win32.mouseInput(pt, 0, 0), win32.mouseInput(pt, win32.BUTTON_DOWN[b], 0)]);
      if (!held.has(viewerId)) held.set(viewerId, new Set());
      held.get(viewerId).add(b);
      return;
    }
    case 'u': {
      const b = ev.b | 0;
      const set = held.get(viewerId);
      if (b < 0 || b > 2 || !set || !set.has(b)) return; // 没按下过就不松开
      set.delete(b);
      const pt = isFiniteNum(ev.x) && isFiniteNum(ev.y) ? win32.toScreen(hwnd, ev.x, ev.y) : null;
      if (pt && win32.isFront(hwnd)) {
        win32.sendInputs([win32.mouseInput(pt, win32.BUTTON_UP[b], 0)]);
      } else {
        win32.sendInputs([win32.buttonOnlyInput(win32.BUTTON_UP[b])]); // 窗口已不在前台：只松键，不动指针
      }
      return;
    }
    case 'w': {
      if (!isFiniteNum(ev.x) || !isFiniteNum(ev.y)) return;
      const dy = Math.max(-2400, Math.min(2400, Math.round(Number(ev.dy) || 0)));
      const dx = Math.max(-2400, Math.min(2400, Math.round(Number(ev.dx) || 0)));
      if (!dx && !dy) return;
      if (!(await ensureFront(hwnd))) return reportError(viewerId, 'front-failed');
      const pt = win32.toScreen(hwnd, ev.x, ev.y);
      if (!pt || !win32.pointHitsWindow(pt, hwnd)) return reportError(viewerId, 'covered');
      const inputs = [win32.mouseInput(pt, 0, 0)];
      if (dy) inputs.push(win32.mouseInput(pt, win32.MOUSEEVENTF_WHEEL, dy));
      if (dx) inputs.push(win32.mouseInput(pt, win32.MOUSEEVENTF_HWHEEL, dx));
      win32.sendInputs(inputs);
      return;
    }
    case 'k': {
      const vk = win32.keyToVk(ev.k);
      if (!vk) return;
      if (!(await ensureFront(hwnd))) return reportError(viewerId, 'front-failed');
      win32.sendInputs(win32.tapInputs(vk, (ev.m | 0) & 7));
      await settleKeyboard(hwnd);
      return;
    }
    case 't': {
      if (typeof ev.s !== 'string' || !ev.s) return;
      const text = ev.s.slice(0, MAX_TEXT).replace(/\r\n?/g, '\n');
      if (!(await ensureFront(hwnd))) return reportError(viewerId, 'front-failed');
      if (text.includes('\n') || text.length > TYPE_LIMIT) {
        await pasteText(hwnd, text);
      } else {
        await typeText(hwnd, text);
      }
      return;
    }
    default:
  }
}

const TYPE_LIMIT = 40; // 超过这个长度的文字改用粘贴，逐字注入太慢
const FIRST_KEY_SETTLE_MS = 150;
const CHAR_GAP_MS = 8;

/** 已经收到过我们键盘输入的窗口 */
const warmed = new Set();

/**
 * 窗口第一次收到键盘输入时，系统要为它初始化输入法，这期间处理按键很慢。
 * 按 Unicode 注入的字符共用一份"当前字符"状态，后面的字符若在前一个被处理前到达，
 * 就会把前一个覆盖掉（实测：首字变成了后面的某个字符）。所以首次按键之后要等它就绪。
 */
async function settleKeyboard(hwnd) {
  if (warmed.has(hwnd)) return;
  warmed.add(hwnd);
  if (warmed.size > 256) warmed.clear();
  await sleep(FIRST_KEY_SETTLE_MS);
}

/** 逐字注入短文字：每个字符单独发送并留出间隔，避免上面说的字符互相覆盖 */
async function typeText(hwnd, text) {
  for (const ch of text) {
    // for...of 按码点遍历，表情这类代理对不会被拆开
    if (!win32.isFront(hwnd)) return;
    win32.sendInputs(win32.textInputs(ch));
    if (warmed.has(hwnd)) await sleep(CHAR_GAP_MS);
    else await settleKeyboard(hwnd);
  }
}

/**
 * 多行或较长的文字走"写剪贴板 + Ctrl+V"，一次粘贴内容完整，也不会因为换行被当成回车而提前发送。
 * 剪贴板不恢复原内容：恢复得早了会把旧内容粘进去，比覆盖剪贴板更糟。
 */
async function pasteText(hwnd, text) {
  // Windows 剪贴板里的换行约定是 CRLF。用 ownWrite 包着：这是控制端刚发来的文字，不要再当成电脑上的复制发回去
  await clipWatch.ownWrite(() => clipboard.writeText(text.replace(/\n/g, '\r\n')), text);
  await sleep(30);
  if (!win32.isFront(hwnd)) return;
  win32.sendInputs(win32.tapInputs(win32.keyToVk('v'), win32.MOD_CTRL));
  await settleKeyboard(hwnd);
  await sleep(120); // 等目标读完剪贴板，再处理后面的按键（比如紧跟着的回车）
}

const IMAGE_MAX = 10 * 1024 * 1024;
/** 粘贴图片后多等一会儿：目标要从剪贴板读出整张图，比读文字慢 */
const IMAGE_SETTLE_MS = 400;

/**
 * 把控制端发来的图片写进剪贴板，再给目标窗口按 Ctrl+V（协议文档 4.5）。
 * 返回错误码，成功时返回 null。和其它输入一样排在 chain 里串行执行。
 */
async function pasteImage(hwnd, bytes) {
  hwnd = Number(hwnd);
  if (!Number.isInteger(hwnd) || !win32.isTargetWindow(hwnd, cfg.targets)) return 'window-gone';
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) return 'image-bad';
  if (bytes.byteLength > IMAGE_MAX) return 'image-too-large';
  const img = nativeImage.createFromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (img.isEmpty()) return 'image-bad';
  // Electron 45 的剪贴板接口照着网页的 Clipboard API 做，图片只收 PNG：JPEG 在这里解码后转一次
  const png = img.toPNG();
  if (!(await ensureFront(hwnd))) return frontFailure();
  // 和粘贴文字一样，不恢复剪贴板原来的内容
  await clipWatch.ownWrite(() => clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]));
  await sleep(30);
  if (!win32.isFront(hwnd)) return frontFailure();
  win32.sendInputs(win32.tapInputs(win32.keyToVk('v'), win32.MOD_CTRL));
  await settleKeyboard(hwnd);
  await sleep(IMAGE_SETTLE_MS);
  const { width, height } = img.getSize();
  console.log(`已粘贴图片 ${width}x${height}，${Math.round(bytes.byteLength / 1024)} KB`);
  return null;
}

function releaseHeld(viewerId) {
  const set = held.get(viewerId);
  if (set && set.size) {
    win32.sendInputs([...set].map((b) => win32.buttonOnlyInput(win32.BUTTON_UP[b])));
  }
  held.delete(viewerId);
}

function isOwnSender(e) {
  return !!mainWindow && e.sender === mainWindow.webContents;
}

ipcMain.on('rc:input', (e, viewerId, hwnd, ev) => {
  if (!isOwnSender(e) || typeof viewerId !== 'string') return;
  chain = chain
    .then(() => handleInput(viewerId, hwnd, ev))
    .catch((err) => console.error('注入输入失败:', err));
});

ipcMain.handle('rc:paste-image', (e, viewerId, hwnd, bytes) => {
  if (!isOwnSender(e) || typeof viewerId !== 'string') return 'image-bad';
  // 同步排进 chain：页面先调这里、再交存下的输入，顺序就和控制端发送的顺序一致
  const task = chain.then(() => pasteImage(hwnd, bytes));
  chain = task.catch((err) => console.error('粘贴图片失败:', err));
  return task.catch(() => 'image-bad');
});

// ---------------------------------------------------------------- 接收文件（协议文档 4.8）

const fileReceiver = new files.FileReceiver({ dir: cfg.fileDir });

/**
 * 把收下的文件的完整路径写进剪贴板，给目标窗口按 Ctrl+V，Claude 就能按路径去读。
 * 返回错误码，成功时返回 null。和其它输入一样排在 chain 里串行执行。
 */
async function pasteFilePath(hwnd, filePath) {
  hwnd = Number(hwnd);
  if (!Number.isInteger(hwnd) || !win32.isTargetWindow(hwnd, cfg.targets)) return 'window-gone';
  if (!(await ensureFront(hwnd))) return frontFailure();
  try {
    // 和粘贴文字一样，不恢复剪贴板原来的内容
    const pathText = files.pasteTextFor(filePath);
    await clipWatch.ownWrite(() => clipboard.writeText(pathText), pathText);
  } catch {
    return frontFailure(); // 锁屏时剪贴板也写不了
  }
  await sleep(30);
  if (!win32.isFront(hwnd)) return frontFailure();
  win32.sendInputs(win32.tapInputs(win32.keyToVk('v'), win32.MOD_CTRL));
  await settleKeyboard(hwnd);
  await sleep(120);
  return null;
}

ipcMain.handle('rc:file-begin', (e, viewerId, id, name, size) => {
  if (!isOwnSender(e) || typeof viewerId !== 'string') return 'file-bad';
  return fileReceiver.begin(viewerId, String(id), String(name == null ? '' : name), size);
});

ipcMain.on('rc:file-data', (e, viewerId, id, bytes) => {
  if (!isOwnSender(e) || typeof viewerId !== 'string' || !(bytes instanceof Uint8Array)) return;
  fileReceiver.write(viewerId, String(id), bytes);
});

ipcMain.on('rc:file-abort', (e, viewerId) => {
  if (!isOwnSender(e) || typeof viewerId !== 'string') return;
  fileReceiver.abort(viewerId);
});

/** 收完了：核对、存成正式文件，再把路径粘贴进 [hwnd]。粘贴失败时文件照样留着，回执里说明没粘贴上 */
ipcMain.handle('rc:file-end', async (e, viewerId, id, sha256, hwnd) => {
  if (!isOwnSender(e) || typeof viewerId !== 'string') return { code: 'file-bad' };
  const r = await fileReceiver.end(viewerId, String(id), typeof sha256 === 'string' ? sha256 : '');
  if (!r.path) return { code: r.code || 'file-failed' };
  const task = chain.then(() => pasteFilePath(hwnd, r.path));
  chain = task.catch((err) => console.error('粘贴文件路径失败:', err));
  const code = await task.catch(() => 'failed');
  console.log(`收到文件 ${r.path}${code ? `，路径没能粘贴: ${code}` : '，已粘贴路径'}`);
  return { path: r.path, name: r.name, pasted: !code, code: code || undefined };
});

// ---------------------------------------------------------------- 窗口平铺（原 claude-window-tiler，协议文档 4.7）

/** 原来的 Python 版平铺工具的隐藏窗口类名；它在运行时内置平铺不启动，免得两个一起挪窗口 */
const PY_TILER_CLASS = 'ClaudeWindowTiler_main';
const PY_TILER_CHECK_MS = 30000;
let tiler = null;
let tilerBlocked = false;
let tilerHotkey = '';

/**
 * 启动内置平铺，之后每 30 秒看一次旧的 Python 版在不在：
 * 旧插件每次 Claude Code 会话启动都会把它拉起来，两个一起跑会抢着挪窗口，所以旧的在时内置的停下，旧的退出后再接手。
 */
function startTiler() {
  // 开发测试时同一台电脑上跑第二个被控端（RC_HOST_PROFILE），它不能也去排窗口
  if (process.env.RC_HOST_NO_TILER) {
    console.log('窗口平铺：设了 RC_HOST_NO_TILER，不启动');
    return;
  }
  checkTiler();
  setInterval(checkTiler, PY_TILER_CHECK_MS);
}

function checkTiler() {
  const pyRunning = win32.hasWindowClass(PY_TILER_CLASS);
  if (pyRunning && !tilerBlocked) {
    console.log('窗口平铺：旧的平铺插件（Python 版）在运行，内置平铺先停下，它退出后自动接手');
    tilerBlocked = true;
    stopTiler();
  } else if (!pyRunning && !tiler) {
    tilerBlocked = false;
    createAndStartTiler();
  }
  refreshTrayMenu();
}

function registerTileHotkey() {
  if (tilerHotkey) globalShortcut.unregister(tilerHotkey);
  tilerHotkey = '';
  const accel = tiler ? tiler.hotkey : '';
  if (!accel) return;
  try {
    if (globalShortcut.register(accel, () => tiler && tiler.arrange('快捷键'))) tilerHotkey = accel;
    else console.warn(`窗口平铺：快捷键 ${accel} 被别的程序占用了`);
  } catch (err) {
    console.warn(`窗口平铺：快捷键 ${accel} 无效:`, err.message);
  }
}

function createAndStartTiler() {
  try {
    const { createTiler } = require('./tiler');
    tiler = createTiler({ log: (msg) => console.log('[平铺] ' + msg) });
    tiler.onChange((change) => {
      if (change && change.what === 'hotkey') registerTileHotkey();
      refreshTrayMenu();
      sendTileState();
    });
    tiler.start();
    registerTileHotkey();
    console.log('窗口平铺已启动，配置文件: ' + tiler.configPath);
  } catch (err) {
    console.error('窗口平铺启动失败:', err);
    tiler = null;
  }
  sendTileState();
}

function stopTiler() {
  if (!tiler) return;
  if (tilerHotkey) globalShortcut.unregister(tilerHotkey);
  tilerHotkey = '';
  tiler.stop();
  tiler = null;
  sendTileState();
}

function tileState() {
  return { available: !!tiler, paused: !!(tiler && tiler.paused) };
}

function sendTileState() {
  if (mainWindow) mainWindow.webContents.send('rc:tile-state', tileState());
}

ipcMain.handle('rc:tile-state', () => tileState());

ipcMain.handle('rc:tile', (e, op) => {
  if (!isOwnSender(e) || !tiler) return false;
  if (op === 'arrange') tiler.arrange('控制端');
  else if (op === 'raise') tiler.raiseAll();
  else if (op === 'pause') tiler.setPaused(true);
  else if (op === 'resume') tiler.setPaused(false);
  else return false;
  return true;
});

// ---------------------------------------------------------------- 自动升级、开机自启（说明见 docs/08）

/** @type {ReturnType<typeof import('./updater').createUpdater> | null} */
let updater = null;

function createUpdater() {
  updater = require('./updater').createUpdater({
    app,
    log: (msg) => console.log('[升级] ' + msg),
    getFeed: () => (account && account.state ? { url: `${account.httpBase}/download/host`, token: account.state.token } : null),
    isIdle: () => trayState.viewers === 0,
  });
  updater.onChange((state) => {
    refreshTrayMenu();
    if (mainWindow) mainWindow.webContents.send('rc:update-state', state);
  });
}

function updateMenuItems() {
  if (!updater) return [];
  const s = updater.state;
  if (s.status === 'dev') return [];
  const text = {
    idle: `版本 ${s.version}`,
    checking: `版本 ${s.version}，正在检查更新…`,
    latest: `版本 ${s.version}，已是最新`,
    downloading: `正在下载新版本 ${s.newVersion}（${s.percent}%）`,
    ready: `新版本 ${s.newVersion} 已下载，没人看画面时自动升级`,
    installing: `正在升级到 ${s.newVersion}…`,
    error: `版本 ${s.version}，检查更新失败`,
  }[s.status];
  const items = [{ label: text, enabled: false }];
  if (s.status === 'ready') items.push({ label: `立即升级到 ${s.newVersion}`, click: () => updater.install() });
  else items.push({ label: '检查更新', enabled: s.status !== 'checking' && s.status !== 'downloading', click: () => updater.check() });
  items.push({
    label: '开机自动启动',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
  });
  items.push({ type: 'separator' });
  return items;
}

/** 装好的正式版第一次运行时打开开机自启（之后以托盘菜单里的勾选为准） */
function setupAutoStart() {
  if (!app.isPackaged || process.env.RC_HOST_PROFILE) return;
  const marker = path.join(app.getPath('userData'), 'autostart-initialized');
  if (fs.existsSync(marker)) return;
  app.setLoginItemSettings({ openAtLogin: true });
  fs.writeFileSync(marker, new Date().toISOString() + '\n');
  console.log('已设置开机自动启动');
}

ipcMain.handle('rc:update-state', () => (updater ? updater.state : null));

/** 控制端要电脑检查更新或马上升级（协议文档 2.6） */
ipcMain.handle('rc:update', (e, op) => {
  if (!isOwnSender(e) || !updater) return null;
  if (op === 'check') updater.check();
  else if (op === 'install') updater.install();
  return updater.state;
});

// ---------------------------------------------------------------- 浏览、打开、新建 Claude 会话（协议文档 2.5，说明见 docs/07）

const sessions = require('./sessions').createSessions({
  log: (msg) => console.log('[会话] ' + msg),
  win32,
  targets: cfg.targets,
  openUrl: (url) => shell.openExternal(url),
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
});

/** 打开、新建会话时会切换 Claude 的窗口，别让平铺当成用户在切换、把所有会话窗口翻到最前 */
function quietTiler() {
  if (tiler) tiler.ignoreActivation(15000);
}

ipcMain.handle('rc:sessions', (e) => (isOwnSender(e) ? sessions.list() : null));

ipcMain.handle('rc:open-session', async (e, id) => {
  if (!isOwnSender(e)) return { ok: false, code: 'failed' };
  quietTiler();
  return sessions.open(id);
});

ipcMain.handle('rc:new-session', async (e, envId) => {
  if (!isOwnSender(e)) return { ok: false, code: 'failed' };
  quietTiler();
  return sessions.create(envId);
});

/** 控制端要关掉一个会话窗口（协议文档 2.8）。会话本身不删，在后台照常跑 */
ipcMain.handle('rc:close-window', async (e, hwnd, title) => {
  if (!isOwnSender(e)) return { ok: false, code: 'failed' };
  return sessions.closeWindow(hwnd, typeof title === 'string' ? title : null);
});

// ---------------------------------------------------------------- 手机审批（协议文档 2.7，说明见 docs/09）

const approvals = require('./approvals').createApprovals({
  log: (msg) => console.log('[审批] ' + msg),
  titleFor: (sid) => sessions.titleForCli(sid),
});

approvals.onChange((list) => {
  if (mainWindow) mainWindow.webContents.send('rc:approvals', list);
});

ipcMain.handle('rc:approvals', (e) => (isOwnSender(e) ? approvals.list : []));

ipcMain.handle('rc:approval-answer', (e, id, ans) => {
  if (!isOwnSender(e) || typeof id !== 'string') return { ok: false, code: 'failed' };
  return approvals.answer(id, ans);
});

// ---------------------------------------------------------------- Claude 升级后自检（docs/07 第 8 节）

const CLAUDE_CHECK_TICK_MS = 60000;

/** 正在运行的 claude.exe 的完整路径（从 Claude 的窗口找到进程），屏幕上没有 Claude 窗口时返回空串 */
function claudeExePath() {
  const w = win32.enumTargetWindows(cfg.targets).find((x) => x.className === 'Chrome_WidgetWin_1');
  return w ? win32.processExePath(win32.windowPid(w.hwnd)) : '';
}

const claudeCheck = require('./claudecheck').createClaudeCheck({
  log: (msg) => console.log('[自检] ' + msg),
  // 放在审批目录旁边（%LOCALAPPDATA%\RemoteClaude\selfcheck.json）：自动修复的定时任务在 Claude 会话里读它，
  // 那里读 %APPDATA% 会被商店版 Claude 转到别处，%LOCALAPPDATA%\RemoteClaude 不会（钩子一直在用）
  stateFile: path.join(path.dirname(approvals.dir), 'selfcheck.json'),
  hostVersion: app.getVersion(),
  claudeExe: claudeExePath,
  sessions,
  locked: () => win32.isLocked(),
  viewers: () => trayState.viewers,
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  before: quietTiler,
  notify: (key, n) => approvals.notify(key, n),
  clearNotice: (key) => approvals.clearNotice(key),
});

// ---------------------------------------------------------------- 桌面端自己弹的确认框提醒手机（docs/09 第 4 节）

const dialogWatchLib = require('./dialogwatch');
const sessionRegistry = dialogWatchLib.createSessionRegistry({
  // 进程号会被别的程序重用，要确实是 Claude Code 的进程才算会话还在
  alive: (pid) => /[\\/]claude\.exe$/i.test(win32.processExePath(pid)),
});
const dialogWatch = dialogWatchLib.createDialogWatch({
  log: (msg) => console.log('[确认框] ' + msg),
  logFile: () => cfg.claudeLogFile || dialogWatchLib.findLogFile(),
  sessionOf: (localId) => {
    const s = sessionRegistry.byLocal(localId);
    if (s.cli && s.title) return s;
    // Claude Code 的登记里没有（或没写标题）时，退回桌面端自己的会话记录
    const rec = sessions.infoForLocal(localId);
    return { ...s, cli: s.cli || rec.cli, title: s.title || rec.title };
  },
  sessionOfCli: (cliId) => sessionRegistry.byCli(cliId),
  approvals: () => approvals.pending(),
  notify: (key, n) => approvals.notify(key, n),
  clearNotice: (key) => approvals.clearNotice(key),
  // 手机上选了"允许一次"或"拒绝"：替用户按电脑上那个框的按钮（会话没有单独的窗口就先开一个）
  press: ({ session, choice, expect }) => {
    quietTiler();
    return sessions.answerDialog(session, choice, expect);
  },
  // 只看不按：会话已经开着的窗口里那个框上写的字（第一次打开某个网站的框，日志里没有网址）
  inspect: (session) => sessions.peekDialog(session),
});

// ---------------------------------------------------------------- 锁定与解锁（协议文档 4.6，解锁服务见 docs/06）

const LOCK_POLL_MS = 2000;
const SERVICE_CHECK_MS = 30000;
// untrusted：管道那头有服务，但核实不过（多半是被控端自动升级了、解锁服务还是旧版），要在电脑上重新安装服务
let lockState = { locked: false, unlock: false, untrusted: false };
let serviceCheckedAt = 0;
let unlocking = false;

// 连上管道后先核实对面确实是装在 Program Files 里、以 SYSTEM 运行的解锁服务，才发命令（docs/06 的"管道防冒充"）
const unlockPipe = require('./unlockpipe').createUnlockPipe({ log: (msg) => console.log('[解锁] ' + msg) });

/** 给解锁服务发一条命令，返回 { line } 或 { error }（'untrusted' 是核实不过，其余是没装、连不上、超时等） */
function askUnlockService(line, timeoutMs) {
  return unlockPipe.request(line, timeoutMs);
}

/** 定时看电脑是否锁屏、解锁服务在不在，有变化就告诉页面，页面再告诉所有控制端 */
async function pollLock() {
  const locked = win32.isLocked();
  let { unlock, untrusted } = lockState;
  if (locked !== lockState.locked || Date.now() - serviceCheckedAt > SERVICE_CHECK_MS) {
    serviceCheckedAt = Date.now();
    const r = await askUnlockService('STATUS', 1500);
    unlock = r.line !== undefined && r.line.startsWith('OK');
    untrusted = r.error === 'untrusted';
  }
  if (locked === lockState.locked && unlock === lockState.unlock && untrusted === lockState.untrusted) return;
  lockState = { locked, unlock, untrusted };
  if (mainWindow) mainWindow.webContents.send('rc:lock-state', lockState);
}

ipcMain.handle('rc:lock-state', () => lockState);

// 画面停了时问一下：窗口还在不在、是不是锁屏了
ipcMain.handle('rc:window-state', (e, hwnd) => {
  hwnd = Number(hwnd);
  return { alive: Number.isInteger(hwnd) && win32.isTargetWindow(hwnd, cfg.targets), locked: win32.isLocked() };
});

// 只在控制端明确要求时锁定；控制端断开时不会自动锁定
ipcMain.handle('rc:lock-now', (e) => {
  if (!isOwnSender(e)) return false;
  const ok = win32.lockWorkStation();
  setTimeout(pollLock, 500);
  return ok;
});

/** 把控制端输入的 Windows 密码交给解锁服务。返回错误码，成功返回 null。密码不写日志、不保存 */
async function unlockWith(password) {
  if (typeof password !== 'string' || !password || password.length > 256) return 'failed';
  if (unlocking) return 'busy';
  if (!win32.isLocked()) return 'not-locked';
  unlocking = true;
  try {
    const r = await askUnlockService('UNLOCK ' + Buffer.from(password, 'utf8').toString('base64'), 40000);
    if (r.line === undefined) return r.error === 'untrusted' ? 'bad-service' : 'no-service';
    const reply = r.line;
    if (reply === 'OK') return null;
    return reply.startsWith('ERR ') ? reply.slice(4).trim() || 'failed' : 'failed';
  } finally {
    unlocking = false;
    setTimeout(pollLock, 300);
  }
}

// 连着画面时：密码走数据通道（端到端加密）到页面，再交到这里
ipcMain.handle('rc:unlock', (e, password) => (isOwnSender(e) ? unlockWith(password) : 'failed'));

// 没连画面时（协议文档 2.9）：密码经服务器转发，用这把公钥加密过，页面和服务器都只见到密文，在这里解开
const unlockKey = require('./unlockkey').createUnlockKey({ log: (msg) => console.log('[解锁] ' + msg) });
unlockKey.ready.then(() => {
  if (mainWindow && unlockKey.publicKey) mainWindow.webContents.send('rc:host-key', unlockKey.publicKey);
});

ipcMain.handle('rc:host-key', (e) => (isOwnSender(e) ? unlockKey.publicKey : null));

ipcMain.handle('rc:unlock-enc', async (e, enc) => {
  if (!isOwnSender(e)) return 'failed';
  const r = unlockKey.open(enc);
  return r.password ? unlockWith(r.password) : r.code;
});

ipcMain.on('rc:release', (e, viewerId) => {
  if (!isOwnSender(e) || typeof viewerId !== 'string') return;
  chain = chain.then(() => releaseHeld(viewerId)).catch(() => {});
});

app.on('before-quit', () => {
  for (const id of [...held.keys()]) releaseHeld(id);
});
