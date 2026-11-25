'use strict';
/**
 * Win32 封装：枚举目标窗口、把窗口切到前台、注入鼠标键盘输入。
 *
 * 安全约束都放在这一层，上层绕不过去：
 *   - 只承认可执行文件名在白名单里的进程的窗口（默认只有 claude.exe）
 *   - 注入输入前必须确认前台窗口属于目标进程，否则丢弃
 *   - 鼠标事件只有落点确实在目标进程的窗口上才注入
 */
const path = require('path');
const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');
const dwmapi = koffi.load('dwmapi.dll');
const advapi32 = koffi.load('advapi32.dll');

// ---------------------------------------------------------------- 类型

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16_t',
  wScan: 'uint16_t',
  dwFlags: 'uint32_t',
  time: 'uint32_t',
  dwExtraInfo: 'uintptr_t',
});
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' });
const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
const INPUT = koffi.struct('INPUT', { type: 'uint32_t', u: INPUT_UNION });
const INPUT_SIZE = koffi.sizeof(INPUT);

const WINDOWPLACEMENT = koffi.struct('WINDOWPLACEMENT', {
  length: 'uint32_t',
  flags: 'uint32_t',
  showCmd: 'uint32_t',
  ptMinPosition: POINT,
  ptMaxPosition: POINT,
  rcNormalPosition: RECT,
});

const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)');

// ---------------------------------------------------------------- 函数

const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumWindowsProc *cb, intptr_t lParam)');
const IsWindow = user32.func('bool __stdcall IsWindow(uintptr_t hWnd)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)');
const IsIconic = user32.func('bool __stdcall IsIconic(uintptr_t hWnd)');
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(uintptr_t hWnd)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, _Out_ uint16_t *buf, int max)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, _Out_ uint16_t *buf, int max)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hWnd, _Out_ uint32_t *pid)');
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ RECT *rect)');
const GetWindowPlacement = user32.func('bool __stdcall GetWindowPlacement(uintptr_t hWnd, _Inout_ WINDOWPLACEMENT *wp)');
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()');
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)');
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(uintptr_t hWnd)');
const ShowWindow = user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int cmd)');
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, bool attach)');
const WindowFromPoint = user32.func('uintptr_t __stdcall WindowFromPoint(POINT pt)');
const GetAncestor = user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hWnd, uint32_t flags)');
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32_t cmd)');
const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');
const MapVirtualKeyW = user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t mapType)');
const SendInput = user32.func('uint32_t __stdcall SendInput(uint32_t count, INPUT *inputs, int size)');

const GetCurrentThreadId = kernel32.func('uint32_t __stdcall GetCurrentThreadId()');
const OpenProcess = kernel32.func('uintptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(uintptr_t handle)');
const QueryFullProcessImageNameW = kernel32.func(
  'bool __stdcall QueryFullProcessImageNameW(uintptr_t handle, uint32_t flags, _Out_ uint16_t *buf, _Inout_ uint32_t *size)'
);
const OpenProcessToken = advapi32.func('bool __stdcall OpenProcessToken(uintptr_t process, uint32_t access, _Out_ uintptr_t *token)');
const GetTokenInformation = advapi32.func(
  'bool __stdcall GetTokenInformation(uintptr_t token, int cls, _Out_ uint32_t *info, uint32_t len, _Out_ uint32_t *retLen)'
);

const DwmGetWindowAttribute = dwmapi.func(
  'long __stdcall DwmGetWindowAttribute(uintptr_t hWnd, uint32_t attr, _Out_ RECT *value, uint32_t size)'
);

// ---------------------------------------------------------------- 常量

const SW_SHOWNOACTIVATE = 4;
const SW_RESTORE = 9;
const GA_ROOT = 2;
const GW_OWNER = 4;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_ELEVATION = 20; // TOKEN_INFORMATION_CLASS.TokenElevation

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0d, Escape: 0x1b, Space: 0x20,
  PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2d, Delete: 0x2e,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75,
  F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
};
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_MENU = 0x12;
// 这些键必须带"扩展键"标志，否则会被当成小键盘上的同名键
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e]);

const MOD_CTRL = 1;
const MOD_SHIFT = 2;
const MOD_ALT = 4;

// 符号键：KeyboardEvent.key -> 美式键盘上的虚拟键码（只在组合键里用到，如 Ctrl+/）
const OEM = {
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};

// ---------------------------------------------------------------- 工具

const num = (v) => (typeof v === 'bigint' ? Number(v) : v);

function readWide(fn, hwnd, cap) {
  const buf = new Uint16Array(cap);
  const len = fn(hwnd, buf, cap);
  return len > 0 ? String.fromCharCode(...buf.subarray(0, len)) : '';
}

function windowTitle(hwnd) {
  const len = GetWindowTextLengthW(hwnd);
  return len > 0 ? readWide(GetWindowTextW, hwnd, len + 1) : '';
}

function windowPid(hwnd) {
  const out = [0];
  GetWindowThreadProcessId(hwnd, out);
  return out[0] >>> 0;
}

function windowThread(hwnd) {
  return GetWindowThreadProcessId(hwnd, [0]) >>> 0;
}

const exeCache = new Map(); // pid -> { name, at }

/** 进程的可执行文件名（小写），取不到时返回空串 */
function processExeName(pid) {
  if (!pid) return '';
  const hit = exeCache.get(pid);
  const now = Date.now();
  if (hit && now - hit.at < 5000) return hit.name;
  let name = '';
  const h = num(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid));
  if (h) {
    try {
      const buf = new Uint16Array(1024);
      const size = [buf.length];
      if (QueryFullProcessImageNameW(h, 0, buf, size)) {
        name = path.win32.basename(String.fromCharCode(...buf.subarray(0, size[0]))).toLowerCase();
      }
    } finally {
      CloseHandle(h);
    }
  }
  exeCache.set(pid, { name, at: now });
  if (exeCache.size > 512) exeCache.clear();
  return name;
}

/** 进程可执行文件的完整路径，取不到时返回空串 */
function processExePath(pid) {
  if (!pid) return '';
  const h = num(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid));
  if (!h) return '';
  try {
    const buf = new Uint16Array(1024);
    const size = [buf.length];
    return QueryFullProcessImageNameW(h, 0, buf, size) ? String.fromCharCode(...buf.subarray(0, size[0])) : '';
  } finally {
    CloseHandle(h);
  }
}

/**
 * 进程是不是以管理员权限运行：'elevated' 提了权；'normal' 没提权；'denied' 连令牌都读不了，
 * 说明它的权限比被控端高（提了权的程序、系统进程）；'unknown' 打不开这个进程。
 */
function processElevation(pid) {
  if (!pid) return 'unknown';
  const h = num(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid));
  if (!h) return 'unknown';
  try {
    const token = [0];
    if (!OpenProcessToken(h, TOKEN_QUERY, token)) return 'denied';
    const t = num(token[0]);
    try {
      const value = [0];
      if (!GetTokenInformation(t, TOKEN_ELEVATION, value, 4, [0])) return 'unknown';
      return value[0] ? 'elevated' : 'normal';
    } finally {
      CloseHandle(t);
    }
  } finally {
    CloseHandle(h);
  }
}

/**
 * 现在挡在最前面的是谁：切不到前台时告诉用户该去电脑上关掉哪个窗口（host/frontblock.js）。
 * 电脑上没有前台窗口时返回 null。
 */
function foregroundInfo() {
  const fg = num(GetForegroundWindow());
  if (!fg) return null;
  const pid = windowPid(fg);
  return { exe: processExeName(pid), title: windowTitle(fg), elevation: processElevation(pid) };
}

const LockWorkStation = user32.func('bool __stdcall LockWorkStation()');
const FindWindowW = user32.func('uintptr_t __stdcall FindWindowW(str16 cls, str16 title)');
const PostMessageW = user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)');
const WM_CLOSE = 0x0010;
const OpenInputDesktop = user32.func('uintptr_t __stdcall OpenInputDesktop(uint32_t flags, bool inherit, uint32_t access)');
const CloseDesktop = user32.func('bool __stdcall CloseDesktop(uintptr_t hDesktop)');
const DESKTOP_READOBJECTS = 0x0001;

/**
 * 电脑是否锁屏。锁屏时系统不让任何程序切换前台窗口、注入键鼠、读写剪贴板，远程操作都会失败。
 * Windows 10/11 的锁屏画面是 LockApp.exe 的窗口；输入密码时切到安全桌面，那时连输入桌面都打不开。
 */
function isLocked() {
  const fg = num(GetForegroundWindow());
  if (fg && processExeName(windowPid(fg)) === 'lockapp.exe') return true;
  const desk = num(OpenInputDesktop(0, false, DESKTOP_READOBJECTS));
  if (!desk) return true;
  CloseDesktop(desk);
  return false;
}

function isTargetProcess(pid, targets) {
  const name = processExeName(pid);
  return !!name && targets.includes(name);
}

/** 窗口的可见边界（物理像素，不含不可见的缩放边框和阴影），与采集到的画面范围一致 */
function frameBounds(hwnd) {
  const r = {};
  if (DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r, koffi.sizeof(RECT)) !== 0) {
    if (!GetWindowRect(hwnd, r)) return null;
  }
  const width = r.right - r.left;
  const height = r.bottom - r.top;
  if (width <= 0 || height <= 0) return null;
  return { left: r.left, top: r.top, width, height };
}

/**
 * 最小化的窗口还原后会回到的位置 [left, top, right, bottom]；取不到时返回 null。
 * 最小化时窗口的实际坐标是 (-32000, -32000)，不能拿来排先后。
 * 这个位置按"工作区坐标"算、还带着看不见的缩放边框，和屏幕坐标可能差出一条任务栏的宽度，只用来排先后够了。
 */
function restoreRect(hwnd) {
  const wp = { length: koffi.sizeof(WINDOWPLACEMENT) };
  if (!GetWindowPlacement(hwnd, wp)) return null;
  const r = wp.rcNormalPosition;
  return r.right > r.left && r.bottom > r.top ? [r.left, r.top, r.right, r.bottom] : null;
}

// ---------------------------------------------------------------- 枚举

/**
 * 列出白名单进程的可见顶层窗口，顺序是系统给的前后顺序（最近操作过的在最前）。
 * 给控制端的列表要另外按屏幕位置排（winorder.js），每一项的 rect 就是排序用的位置。
 * @param {string[]} targets 小写的可执行文件名，如 ['claude.exe']
 */
function enumTargetWindows(targets) {
  const list = [];
  EnumWindows((h) => {
    const hwnd = num(h);
    if (!IsWindowVisible(hwnd)) return true;
    const pid = windowPid(hwnd);
    if (!isTargetProcess(pid, targets)) return true;
    const title = windowTitle(hwnd);
    if (!title) return true;
    const minimized = IsIconic(hwnd);
    // 最小化的窗口取不到正常尺寸，先放行，选中时再还原
    const b = frameBounds(hwnd);
    if (!minimized && (!b || b.width < 120 || b.height < 120)) return true; // 跳过托盘气泡之类的小窗
    list.push({
      hwnd,
      pid,
      title,
      minimized,
      className: readWide(GetClassNameW, hwnd, 256),
      width: b ? b.width : 0,
      height: b ? b.height : 0,
      // 在屏幕上的位置 [left, top, right, bottom]；最小化的取还原后会回到的位置，这样最小化不改变它在列表里的先后
      rect: minimized ? restoreRect(hwnd) : [b.left, b.top, b.left + b.width, b.top + b.height],
    });
    return true;
  }, 0);
  return list;
}

/** 该窗口现在是否仍然存在且属于白名单进程 */
function isTargetWindow(hwnd, targets) {
  return IsWindow(hwnd) && IsWindowVisible(hwnd) && isTargetProcess(windowPid(hwnd), targets);
}

/** 最小化的窗口无法采集，先还原（不抢焦点）。返回是否做了还原。 */
function restoreIfMinimized(hwnd) {
  if (!IsIconic(hwnd)) return false;
  ShowWindow(hwnd, SW_SHOWNOACTIVATE);
  return true;
}

// ---------------------------------------------------------------- 前台

/** w 就是 hwnd 本身，或是 hwnd 弹出的附属窗口（菜单、对话框） */
function isSameOrOwned(w, hwnd) {
  if (!w) return false;
  if (w === hwnd) return true;
  return num(GetWindow(w, GW_OWNER)) === hwnd;
}

/** 目标窗口（或它弹出的附属窗口）当前是否在前台。同一进程的其它会话窗口不算。 */
function isFront(hwnd) {
  return isSameOrOwned(num(GetForegroundWindow()), hwnd);
}

function keyInput(vk, flags) {
  const scan = vk ? MapVirtualKeyW(vk, 0) & 0xffff : 0;
  const ext = EXTENDED.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0;
  return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags | ext, time: 0, dwExtraInfo: 0 } } };
}

function sendInputs(inputs) {
  if (!inputs.length) return 0;
  return SendInput(inputs.length, inputs, INPUT_SIZE);
}

/**
 * 把窗口切到前台。Windows 限制后台进程抢前台，所以依次尝试几种办法。
 * 返回最终是否成功：目标窗口或它弹出的附属窗口在前台都算，和 isFront 一样。
 */
function bringToFront(hwnd) {
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  if (isFront(hwnd)) return true;

  SetForegroundWindow(hwnd);
  if (isFront(hwnd)) return true;

  // 办法二：临时挂接到当前前台线程的输入队列，借用它的"前台权限"
  const fg = num(GetForegroundWindow());
  const fgThread = fg ? windowThread(fg) : 0;
  const self = GetCurrentThreadId();
  const attached = fgThread && fgThread !== self && AttachThreadInput(self, fgThread, true);
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  if (attached) AttachThreadInput(self, fgThread, false);
  if (isFront(hwnd)) return true;

  // 办法三：按住 Alt 时系统会放行 SetForegroundWindow
  sendInputs([keyInput(VK_MENU, 0)]);
  SetForegroundWindow(hwnd);
  sendInputs([keyInput(VK_MENU, KEYEVENTF_KEYUP)]);
  return isFront(hwnd);
}

// ---------------------------------------------------------------- 注入

/** 把窗口内的归一化坐标 (0~1) 换算成屏幕物理像素 */
function toScreen(hwnd, nx, ny) {
  const b = frameBounds(hwnd);
  if (!b) return null;
  const cx = Math.min(Math.max(nx, 0), 1);
  const cy = Math.min(Math.max(ny, 0), 1);
  return {
    x: b.left + Math.min(b.width - 1, Math.round(cx * (b.width - 1))),
    y: b.top + Math.min(b.height - 1, Math.round(cy * (b.height - 1))),
  };
}

/** 屏幕上这一点最上层的窗口是否就是目标窗口（防止点到盖在上面的别的程序或别的会话） */
function pointHitsWindow(pt, hwnd) {
  const w = num(WindowFromPoint(pt));
  if (!w) return false;
  return isSameOrOwned(num(GetAncestor(w, GA_ROOT)) || w, hwnd);
}

/** 只松开/按下按键、不移动指针（目标窗口已不在前台时用来安全地松开按键） */
function buttonOnlyInput(flags) {
  return { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
}

function mouseInput(pt, flags, data) {
  const vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  const vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  const vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  // 绝对坐标以整个虚拟桌面为 0~65535
  const dx = Math.round(((pt.x - vx) * 65535) / Math.max(1, vw - 1));
  const dy = Math.round(((pt.y - vy) * 65535) / Math.max(1, vh - 1));
  return {
    type: INPUT_MOUSE,
    u: {
      mi: {
        dx,
        dy,
        mouseData: (data || 0) >>> 0,
        dwFlags: flags | MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
}

/**
 * 叫醒显示器：注入一次鼠标微动（右移 1 像素再移回来），和有人碰了一下鼠标一样，指针最后还在原地。
 * 显示器因为没人操作关掉以后，Claude（Chromium）认为所有窗口都被挡住、不再刷新画面；这时把藏着的窗口
 * 重新显示出来，它也一直不画（docs/07 第 6 节）。防息屏（powerSaveBlocker）只能拦着不关，叫不醒已经关掉的显示器。
 * 返回注入成功的事件数；锁屏时注入不了，返回 0。
 */
function wakeDisplay() {
  const move = (dx) => ({ type: INPUT_MOUSE, u: { mi: { dx, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 } } });
  return sendInputs([move(1), move(-1)]);
}

const BUTTON_DOWN = [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_RIGHTDOWN];
const BUTTON_UP = [MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP];

function keyToVk(key) {
  if (typeof key !== 'string' || !key) return 0;
  if (VK[key]) return VK[key];
  if (key === ' ') return VK.Space;
  if (key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c; // 0-9 A-Z 的虚拟键码就是字符码
    if (OEM[key]) return OEM[key];
  }
  return 0;
}

function tapInputs(vk, mods) {
  const downs = [];
  const ups = [];
  if (mods & MOD_CTRL) { downs.push(keyInput(VK_CONTROL, 0)); ups.unshift(keyInput(VK_CONTROL, KEYEVENTF_KEYUP)); }
  if (mods & MOD_SHIFT) { downs.push(keyInput(VK_SHIFT, 0)); ups.unshift(keyInput(VK_SHIFT, KEYEVENTF_KEYUP)); }
  if (mods & MOD_ALT) { downs.push(keyInput(VK_MENU, 0)); ups.unshift(keyInput(VK_MENU, KEYEVENTF_KEYUP)); }
  return [...downs, keyInput(vk, 0), keyInput(vk, KEYEVENTF_KEYUP), ...ups];
}

/** 按 Unicode 码元直接注入文字，不经过被控端的输入法 */
function textInputs(text) {
  const inputs = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } });
    inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } });
  }
  return inputs;
}

// ---------------------------------------------------------------- 剪贴板（协议文档 4.9）

const GetClipboardSequenceNumber = user32.func('uint32_t __stdcall GetClipboardSequenceNumber()');
const IsClipboardFormatAvailable = user32.func('bool __stdcall IsClipboardFormatAvailable(uint32_t format)');
const RegisterClipboardFormatW = user32.func('uint32_t __stdcall RegisterClipboardFormatW(str16 name)');
const CF_UNICODETEXT = 13;

/**
 * 密码管理器这类程序往剪贴板放内容时会带上这两个格式，意思是"监视剪贴板的程序不要处理"。
 * 第一个是 Windows 自己的约定（剪贴板历史、云剪贴板都认），第二个是更早的民间约定。
 */
const EXCLUDE_FORMAT_NAMES = ['ExcludeClipboardContentFromMonitorProcessing', 'Clipboard Viewer Ignore'];
let excludeFormats = null;

/** 剪贴板序号：内容每变一次就加。只读一个数，不打开剪贴板，可以频繁调 */
function clipboardSeq() {
  return GetClipboardSequenceNumber() >>> 0;
}

/** 剪贴板里有没有文字（不打开剪贴板） */
function clipboardHasText() {
  return !!IsClipboardFormatAvailable(CF_UNICODETEXT);
}

/** 剪贴板里的内容是不是标了"不要让监视剪贴板的程序处理" */
function clipboardExcluded() {
  if (!excludeFormats) excludeFormats = EXCLUDE_FORMAT_NAMES.map((n) => RegisterClipboardFormatW(n) >>> 0).filter(Boolean);
  return excludeFormats.some((f) => !!IsClipboardFormatAvailable(f));
}

module.exports = {
  MOD_CTRL,
  MOD_SHIFT,
  MOD_ALT,
  VK,
  clipboardSeq,
  clipboardHasText,
  clipboardExcluded,
  enumTargetWindows,
  isTargetWindow,
  restoreIfMinimized,
  windowPid,
  processExePath,
  windowTitle,
  frameBounds,
  isFront,
  foregroundInfo,
  processElevation,
  isLocked,
  lockWorkStation: () => !!LockWorkStation(),
  /** 让窗口自己关闭，效果和点窗口的 × 一样（发 WM_CLOSE，不动鼠标键盘）。只表示消息发出去了 */
  postClose: (hwnd) => !!PostMessageW(hwnd, WM_CLOSE, 0, 0),
  /** 有没有这个类名的顶层窗口（用来发现别的程序是否在运行） */
  hasWindowClass: (cls) => !!num(FindWindowW(cls, null)),
  bringToFront,
  toScreen,
  pointHitsWindow,
  mouseInput,
  buttonOnlyInput,
  keyToVk,
  tapInputs,
  textInputs,
  sendInputs,
  wakeDisplay,
  BUTTON_DOWN,
  BUTTON_UP,
  MOUSEEVENTF_WHEEL,
  MOUSEEVENTF_HWHEEL,
};
