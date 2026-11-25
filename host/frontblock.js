'use strict';
/**
 * 切不到前台时，记下挡在最前面的是哪个程序（协议文档第 5 节的 detail）：
 * 写一行日志，再给控制端的"无法把该窗口切到前台"补一句说明，让用户知道该去电脑上关掉谁。
 *
 * 最常见的是以管理员权限运行的窗口挡在最前面（任务管理器、管理员终端、安装程序、远程控制软件）：
 * 被控端是普通权限，Windows 不让它把这种窗口换下去，也不让它往里发键盘鼠标。
 *
 * 前台窗口的信息由 win32.foregroundInfo() 取，这里只管措辞和去重，不依赖 Electron，测试里直接 require。
 */

/** 说明里的窗口标题最多这么多个字符，再长的截掉 */
const TITLE_MAX = 30;
/** 同一个程序挡着，这么久内只记一次日志（每按一个键都会失败一次） */
const LOG_EVERY_MS = 10000;
/** 记下的前台信息只在这么久内有效：报错紧跟在切换失败后面，过了这么久的不再拿来说明 */
const FRESH_MS = 3000;

/** elevation 为这两种时算"管理员权限"：读得到、确实提了权；或者权限比被控端高，连令牌都读不了 */
const HIGHER = new Set(['elevated', 'denied']);

/** 标题里的换行和连续空白合成一个空格，太长的截掉（按字符截，不把表情这类字符切成两半） */
function shortTitle(title) {
  const chars = Array.from(title.replace(/\s+/g, ' ').trim());
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') + '…' : chars.join('');
}

/** 说明里怎么称呼这个窗口：「任务管理器」（taskmgr.exe）；没有标题时只用程序名 */
function blockerName(info) {
  const title = shortTitle(info.title);
  if (title && info.exe) return `「${title}」（${info.exe}）`;
  if (title || info.exe) return `「${title || info.exe}」`;
  return '';
}

/**
 * 给控制端的补充说明，接在"电脑上无法把该窗口切到前台"后面。
 * @param {{ exe: string, title: string, elevation: string } | null} info 前台窗口的信息；null 是电脑上现在没有前台窗口
 * @param {boolean} [selfElevated] 被控端自己是不是管理员权限：是的话管理员权限的窗口它也切得走，不能说"切不走它"
 * @returns {string | null} 标题和程序名都取不到时返回 null
 */
function describeBlocker(info, selfElevated = false) {
  if (info === null) return '电脑上现在没有窗口在前台';
  const name = blockerName(info);
  if (!name) return null;
  if (!HIGHER.has(info.elevation)) return `最前面是${name}`;
  if (selfElevated) return `最前面是管理员权限的${name}`;
  return `最前面是管理员权限的${name}，被控端切不走它，请在电脑上关掉或最小化它`;
}

/** 日志里的一行：切不到前台，最前面是 taskmgr.exe「任务管理器」（管理员权限） */
function logLine(info) {
  if (info === null) return '切不到前台，电脑上现在没有窗口在前台';
  const level = HIGHER.has(info.elevation) ? '管理员权限' : info.elevation === 'normal' ? '普通权限' : '权限不明';
  return `切不到前台，最前面是 ${info.exe || '（不知道是哪个程序）'}「${shortTitle(info.title)}」（${level}）`;
}

/**
 * @param {{ log: (line: string) => void, selfElevated?: boolean, now?: () => number }} opts
 */
function createFrontBlock({ log, selfElevated = false, now = Date.now }) {
  let last = { info: undefined, at: 0 };
  let logged = { key: '', at: -Infinity };

  return {
    /** 切换失败时调用，传入当时的前台信息（win32.foregroundInfo() 的结果） */
    note(info) {
      const t = now();
      last = { info, at: t };
      // 标题不进去：终端、浏览器的标题跟着内容变，算进去就去不了重
      const key = info === null ? '' : `${info.exe}|${info.elevation}`;
      if (key === logged.key && t - logged.at < LOG_EVERY_MS) return;
      logged = { key, at: t };
      log(logLine(info));
    },
    /** 刚才那次切换失败的补充说明；太久以前的、说不出什么的返回 null */
    detail() {
      if (last.info === undefined || now() - last.at > FRESH_MS) return null;
      return describeBlocker(last.info, selfElevated);
    },
  };
}

module.exports = { describeBlocker, logLine, createFrontBlock, TITLE_MAX, LOG_EVERY_MS, FRESH_MS };
