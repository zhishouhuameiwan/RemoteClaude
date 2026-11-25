'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeBlocker, logLine, createFrontBlock, TITLE_MAX, LOG_EVERY_MS, FRESH_MS } = require('../frontblock');

const TASKMGR = { exe: 'taskmgr.exe', title: '任务管理器', elevation: 'elevated' };

/** 假的钟和日志：clock 由测试往前拨 */
function fake() {
  const t = { clock: 1000, logs: [] };
  t.block = createFrontBlock({ log: (line) => t.logs.push(line), now: () => t.clock });
  return t;
}

test('管理员权限的窗口挡着：说出是谁，让用户去电脑上关掉', () => {
  assert.equal(
    describeBlocker(TASKMGR),
    '最前面是管理员权限的「任务管理器」（taskmgr.exe），被控端切不走它，请在电脑上关掉或最小化它'
  );
});

test('连令牌都读不了（权限比被控端高）也算管理员权限', () => {
  const d = describeBlocker({ exe: 'sunloginclient.exe', title: '向日葵', elevation: 'denied' });
  assert.ok(d.startsWith('最前面是管理员权限的「向日葵」（sunloginclient.exe）'), d);
});

test('普通权限、权限不明的窗口：只说是谁，不说管理员', () => {
  assert.equal(describeBlocker({ exe: 'notepad.exe', title: '无标题 - 记事本', elevation: 'normal' }), '最前面是「无标题 - 记事本」（notepad.exe）');
  assert.equal(describeBlocker({ exe: 'x.exe', title: 'X', elevation: 'unknown' }), '最前面是「X」（x.exe）');
});

test('没有标题时只用程序名，没有程序名时只用标题', () => {
  assert.equal(describeBlocker({ exe: 'taskmgr.exe', title: '', elevation: 'elevated' }).slice(0, 24), '最前面是管理员权限的「taskmgr.exe」，');
  assert.equal(describeBlocker({ exe: '', title: '某个窗口', elevation: 'normal' }), '最前面是「某个窗口」');
});

test('标题和程序名都没有：说不出什么，返回 null', () => {
  assert.equal(describeBlocker({ exe: '', title: '  ', elevation: 'elevated' }), null);
});

test('被控端自己是管理员权限：只说是谁，不说"切不走它"', () => {
  assert.equal(describeBlocker(TASKMGR, true), '最前面是管理员权限的「任务管理器」（taskmgr.exe）');
  const t = { clock: 0 };
  const block = createFrontBlock({ log: () => {}, selfElevated: true, now: () => t.clock });
  block.note(TASKMGR);
  assert.equal(block.detail(), '最前面是管理员权限的「任务管理器」（taskmgr.exe）');
});

test('电脑上没有前台窗口', () => {
  assert.equal(describeBlocker(null), '电脑上现在没有窗口在前台');
  assert.equal(logLine(null), '切不到前台，电脑上现在没有窗口在前台');
});

test('太长的标题截掉，换行和连续空白合成一个空格', () => {
  const long = 'a'.repeat(TITLE_MAX + 10);
  assert.equal(describeBlocker({ exe: 'p.exe', title: long, elevation: 'normal' }), `最前面是「${'a'.repeat(TITLE_MAX)}…」（p.exe）`);
  assert.equal(describeBlocker({ exe: 'p.exe', title: ' 管理员:\r\n  PowerShell ', elevation: 'normal' }), '最前面是「管理员: PowerShell」（p.exe）');
});

test('按字符截标题，表情不会被切成两半', () => {
  const title = 'a'.repeat(TITLE_MAX - 1) + '😀' + 'b';
  assert.equal(describeBlocker({ exe: 'p.exe', title, elevation: 'normal' }), `最前面是「${'a'.repeat(TITLE_MAX - 1)}😀…」（p.exe）`);
});

test('日志行写明程序、标题和权限', () => {
  assert.equal(logLine(TASKMGR), '切不到前台，最前面是 taskmgr.exe「任务管理器」（管理员权限）');
  assert.equal(logLine({ exe: 'notepad.exe', title: '记事本', elevation: 'normal' }), '切不到前台，最前面是 notepad.exe「记事本」（普通权限）');
  assert.equal(logLine({ exe: 'svc.exe', title: 'S', elevation: 'denied' }), '切不到前台，最前面是 svc.exe「S」（管理员权限）');
  assert.equal(logLine({ exe: '', title: '', elevation: 'unknown' }), '切不到前台，最前面是 （不知道是哪个程序）「」（权限不明）');
});

test('同一个程序一直挡着：10 秒内只记一次日志，过了再记', () => {
  const t = fake();
  t.block.note(TASKMGR);
  t.clock += 500;
  t.block.note(TASKMGR);
  t.clock += LOG_EVERY_MS - 600;
  t.block.note(TASKMGR);
  assert.equal(t.logs.length, 1, t.logs.join('\n'));
  t.clock += 200;
  t.block.note(TASKMGR);
  assert.equal(t.logs.length, 2);
});

test('同一个程序只是标题在变（终端、浏览器）：照样去重，说明用最新的标题', () => {
  const t = fake();
  t.block.note({ exe: 'windowsterminal.exe', title: '管理员: C:\\a', elevation: 'denied' });
  t.block.note({ exe: 'windowsterminal.exe', title: '管理员: C:\\b', elevation: 'denied' });
  assert.equal(t.logs.length, 1, t.logs.join('\n'));
  assert.ok(t.block.detail().includes('「管理员: C:\\b」'), t.block.detail());
});

test('换了挡着的程序马上记', () => {
  const t = fake();
  t.block.note(TASKMGR);
  t.block.note({ exe: 'notepad.exe', title: '记事本', elevation: 'normal' });
  t.block.note(null);
  assert.deepEqual(t.logs, [
    '切不到前台，最前面是 taskmgr.exe「任务管理器」（管理员权限）',
    '切不到前台，最前面是 notepad.exe「记事本」（普通权限）',
    '切不到前台，电脑上现在没有窗口在前台',
  ]);
});

test('detail 给的是刚才那次失败的说明，日志去重不影响它', () => {
  const t = fake();
  assert.equal(t.block.detail(), null, '还没失败过');
  t.block.note(TASKMGR);
  t.block.note(TASKMGR); // 没记日志，说明照样有
  assert.equal(t.block.detail(), describeBlocker(TASKMGR));
  t.block.note(null);
  assert.equal(t.block.detail(), '电脑上现在没有窗口在前台');
});

test('太久以前的失败不再拿来说明', () => {
  const t = fake();
  t.block.note(TASKMGR);
  t.clock += FRESH_MS;
  assert.equal(t.block.detail(), describeBlocker(TASKMGR));
  t.clock += 1;
  assert.equal(t.block.detail(), null);
});
