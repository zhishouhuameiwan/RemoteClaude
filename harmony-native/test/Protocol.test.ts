// 对照 android/app/src/test/.../protocol/ProtocolTest.kt。消息样例取自 docs/03-protocol.md（协议版本 2）和服务器的实际输出。
// Kotlin 的 Protocol.parse 对应 parseIncoming；数据通道上的 parseXxx 都合并成了 parseChannelMessage / parseFileReply。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUTTON_RIGHT,
  DETAIL_MAX,
  MOD_SHIFT,
  PROTOCOL_VERSION,
  THUMBS_DONE,
  THUMBS_PENDING,
  answerMessage,
  approvalAnswerMessage,
  authMessage,
  closeWindowMessage,
  downEvent,
  fileBeginEvent,
  fileCancelEvent,
  fileEndEvent,
  hostCmdMessage,
  hostUpdateMessage,
  iceMessage,
  imageBeginEvent,
  imageEndEvent,
  keyEvent,
  listMessage,
  listSessionsMessage,
  lockNowEvent,
  moveEvent,
  newSessionMessage,
  openSessionMessage,
  parseAppUpdate,
  parseChannelMessage,
  parseFileReply,
  parseIncoming,
  pushRegisterMessage,
  pushUnregisterMessage,
  selectMessage,
  stopMessage,
  textEvent,
  tileEvent,
  unlockEvent,
  upEvent,
  wheelEvent,
  withDetail,
} from '../entry/src/main/ets/protocol/Protocol';
import type { Incoming } from '../entry/src/main/ets/protocol/Protocol';

type Obj = Record<string, unknown>;

function obj(s: string): Obj {
  return JSON.parse(s) as Obj;
}

/** 解析并要求是某一类消息 */
function parseAs<T extends Incoming['type']>(text: string, type: T): Extract<Incoming, { type: T }> {
  const msg = parseIncoming(text);
  assert.ok(msg !== null, `应当能解析：${text}`);
  assert.equal(msg.type, type);
  return msg as Extract<Incoming, { type: T }>;
}

test('auth-ok 带电脑列表和 TURN 服务器', () => {
  const msg = parseAs(
    `{"type":"auth-ok","role":"viewer","id":"a1b2c3d4e5f6","email":"a@example.com",
      "iceServers":[{"urls":["turn:rc.example.com:3478?transport=udp"],"username":"1794990000","credential":"abc="},
                    {"urls":"stun:rc.example.com:3478"}],
      "hosts":[{"id":"k3J9","name":"办公室电脑","online":true},{"id":"home","name":"家里","online":false},{"name":"缺 id，应忽略"}]}`,
    'auth-ok',
  );
  assert.equal(msg.email, 'a@example.com');
  assert.equal(msg.id, 'a1b2c3d4e5f6');
  assert.deepEqual(msg.hosts, [
    { id: 'k3J9', name: '办公室电脑', online: true },
    { id: 'home', name: '家里', online: false },
  ]);
  assert.equal(msg.iceServers.length, 2);
  assert.equal(msg.iceServers[0].username, '1794990000');
  assert.deepEqual(msg.iceServers[1].urls, ['stun:rc.example.com:3478']);
  assert.equal(msg.iceServers[1].credential, undefined);
});

test('auth-fail 和 hosts', () => {
  assert.deepEqual(parseIncoming('{"type":"auth-fail","reason":"revoked"}'), { type: 'auth-fail', reason: 'revoked' });
  assert.deepEqual(parseIncoming('{"type":"hosts","hosts":[{"id":"pc","name":"","online":false}]}'), {
    type: 'hosts',
    hosts: [{ id: 'pc', name: '电脑', online: false }],
  });
});

test('窗口列表带 host', () => {
  const msg = parseAs(
    `{"type":"windows","host":"pc-1","list":[
      {"hwnd":40571112,"title":"Claude窗口远程控制工具","minimized":false,"width":854,"height":1380,"thumb":"data:image/jpeg;base64,AAAA"},
      {"hwnd":3150534,"title":"已最小化的会话","minimized":true,"width":0,"height":0,"thumb":null},
      {"title":"缺少句柄，应被忽略"}]}`,
    'windows',
  );
  assert.equal(msg.host, 'pc-1');
  assert.equal(msg.list.length, 2);
  assert.equal(msg.list[0].hwnd, 40571112);
  assert.equal(msg.list[0].width, 854);
  assert.equal(msg.list[0].thumb, 'data:image/jpeg;base64,AAAA');
  assert.equal(msg.list[1].minimized, true);
  assert.equal(msg.list[1].thumb, null);
  // 一次回完的列表（旧版被控端）没有 thumbs
  assert.equal(msg.thumbs, null);
});

test('窗口列表可以先到，缩略图后补', () => {
  const list = obj(listMessage('pc'));
  assert.equal(list['type'], 'list');
  assert.equal(list['thumbs'], 'later');

  const first = parseAs(
    `{"type":"windows","host":"pc-1","thumbs":"pending","list":[
      {"hwnd":7,"title":"会话","minimized":false,"width":854,"height":1380,"thumb":null,"closable":true}]}`,
    'windows',
  );
  assert.equal(first.thumbs, THUMBS_PENDING);
  assert.equal(first.list[0].title, '会话');
  assert.equal(first.list[0].thumb, null);

  const second = parseAs(
    `{"type":"windows","host":"pc-1","thumbs":"done","list":[
      {"hwnd":7,"title":"会话","minimized":false,"width":854,"height":1380,"thumb":"data:image/jpeg;base64,AAAA","closable":true}]}`,
    'windows',
  );
  assert.equal(second.thumbs, THUMBS_DONE);
  assert.equal(second.list[0].thumb, 'data:image/jpeg;base64,AAAA');
});

test('缩略图不是图片的 data URL 时丢掉', () => {
  const msg = parseAs('{"type":"windows","host":"h","list":[{"hwnd":1,"thumb":"javascript:alert(1)"}]}', 'windows');
  assert.equal(msg.list[0].thumb, null);
});

test('电脑发来的 offer、ice、selected、window-closed、error', () => {
  assert.deepEqual(parseIncoming('{"type":"offer","host":"h","sdp":{"type":"offer","sdp":"v=0\\r\\n"},"hwnd":7,"title":"T"}'), {
    type: 'offer',
    host: 'h',
    sdp: 'v=0\r\n',
    hwnd: 7,
    title: 'T',
  });
  assert.deepEqual(
    parseIncoming(
      '{"type":"ice","host":"h","candidate":{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0}}',
    ),
    { type: 'ice', host: 'h', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } },
  );
  assert.deepEqual(parseIncoming('{"type":"selected","host":"h","hwnd":9,"title":"S"}'), {
    type: 'selected',
    host: 'h',
    hwnd: 9,
    title: 'S',
  });
  assert.deepEqual(parseIncoming('{"type":"window-closed","host":"h"}'), { type: 'window-closed', host: 'h' });
  assert.deepEqual(parseIncoming('{"type":"error","code":"host-offline","host":"h"}'), {
    type: 'error',
    host: 'h',
    code: 'host-offline',
  });
});

test('不认识的和格式不对的返回 null', () => {
  assert.equal(parseIncoming('{"type":"something-new"}'), null);
  assert.equal(parseIncoming('not json'), null);
  assert.equal(parseIncoming('["array"]'), null);
  assert.equal(parseIncoming('null'), null);
  assert.equal(parseIncoming('{"type":"offer","sdp":"wrong shape"}'), null);
  assert.equal(parseIncoming('{"type":"ice","host":"h","candidate":{}}'), null);
});

test('数据通道上的输入错误', () => {
  assert.deepEqual(parseChannelMessage('{"t":"err","code":"covered"}'), { t: 'err', code: 'covered', detail: null });
  assert.equal(parseChannelMessage('{"t":"m","x":0.5,"y":0.5}'), null);
  assert.equal(parseChannelMessage('不是 JSON'), null);
});

test('输入错误带着被控端写的补充说明', () => {
  const detail = '最前面是管理员权限的「任务管理器」（taskmgr.exe）';
  assert.deepEqual(parseChannelMessage(JSON.stringify({ t: 'err', code: 'front-failed', detail })), { t: 'err', code: 'front-failed', detail });
  assert.equal(withDetail('电脑上无法把该窗口切到前台', detail), `电脑上无法把该窗口切到前台：${detail}`);
  // 没有说明（旧版被控端）时提示不变
  assert.equal(withDetail('该窗口已关闭', null), '该窗口已关闭');
});

test('输入错误的补充说明：去掉控制字符和首尾空白，空的、不是字符串的不认，太长的截掉', () => {
  const detailOf = (d: unknown): string | null => {
    const m = parseChannelMessage(JSON.stringify({ t: 'err', code: 'x', detail: d }));
    return m !== null && m.t === 'err' ? m.detail : 'not-err';
  };
  assert.equal(detailOf(' a\nb\u0007\u0085 '), 'ab');
  assert.equal(detailOf('   '), null);
  assert.equal(detailOf(12), null);
  assert.equal(detailOf('字'.repeat(DETAIL_MAX + 50))?.length, DETAIL_MAX);
});

test('登录和信令消息', () => {
  const auth = obj(authMessage('tok', 'harmony/0.1.0'));
  assert.equal(auth['type'], 'auth');
  assert.equal(auth['role'], 'viewer');
  assert.equal(auth['token'], 'tok');
  assert.equal(auth['proto'], 2);
  assert.equal(PROTOCOL_VERSION, 2);
  assert.equal(auth['client'], 'harmony/0.1.0');

  assert.equal(obj(listMessage('pc'))['host'], 'pc');
  const select = obj(selectMessage('pc', 40571112));
  assert.deepEqual(select, { type: 'select', host: 'pc', hwnd: 40571112 });
  assert.deepEqual(obj(stopMessage('pc')), { type: 'stop', host: 'pc' });

  const answer = obj(answerMessage('pc', 'v=0\r\na=x\r\n'));
  assert.equal(answer['host'], 'pc');
  assert.deepEqual(answer['sdp'], { type: 'answer', sdp: 'v=0\r\na=x\r\n' });

  const ice = obj(iceMessage('pc', { candidate: 'candidate:x', sdpMid: '0', sdpMLineIndex: 0 }));
  assert.equal(ice['host'], 'pc');
  assert.deepEqual(ice['candidate'], { candidate: 'candidate:x', sdpMid: '0', sdpMLineIndex: 0 });
  // sdpMid 为 null 时照样带上
  assert.deepEqual(obj(iceMessage('pc', { candidate: 'c', sdpMid: null, sdpMLineIndex: 1 }))['candidate'], {
    candidate: 'c',
    sdpMid: null,
    sdpMLineIndex: 1,
  });
});

test('输入事件符合协议', () => {
  const click = obj(downEvent(0.123456789, 0.5, BUTTON_RIGHT));
  assert.equal(click['t'], 'd');
  assert.equal(click['x'], 0.12346);
  assert.equal(click['b'], 2);
  assert.ok(downEvent(0.123456789, 0.5, BUTTON_RIGHT).includes('"x":0.12346'));
  assert.deepEqual(obj(moveEvent(0.5, 1)), { t: 'm', x: 0.5, y: 1 });
  assert.deepEqual(obj(upEvent(0, 0.999999, 0)), { t: 'u', x: 0, y: 1, b: 0 });

  const wheel = obj(wheelEvent(0.123456789, 0.5, 0, -120));
  assert.equal(wheel['t'], 'w');
  assert.equal(wheel['dx'], 0);
  assert.equal(wheel['dy'], -120);

  const key = obj(keyEvent('Enter', MOD_SHIFT));
  assert.equal(key['k'], 'Enter');
  assert.equal(key['m'], 2);
});

test('文字事件保留中文、表情和换行', () => {
  const s = '你好，Claude! abc 123 😀\n第二行';
  assert.equal(obj(textEvent(s))['s'], s);
});

test('图片消息符合 4.5 节', () => {
  assert.deepEqual(obj(imageBeginEvent('k3f9a2', 'image/jpeg', 345678)), {
    t: 'img',
    id: 'k3f9a2',
    mime: 'image/jpeg',
    size: 345678,
  });
  assert.deepEqual(obj(imageEndEvent('k3f9a2')), { t: 'img-end', id: 'k3f9a2' });
});

test('文件消息符合 4.8 节', () => {
  assert.deepEqual(obj(fileBeginEvent('f1a2', '季度报告 v2.pdf', 123_456_789)), {
    t: 'file',
    id: 'f1a2',
    name: '季度报告 v2.pdf',
    size: 123_456_789,
  });
  assert.deepEqual(obj(fileEndEvent('f1a2', 'ab'.repeat(32))), { t: 'file-end', id: 'f1a2', sha256: 'ab'.repeat(32) });
  assert.deepEqual(obj(fileCancelEvent('f1a2')), { t: 'file-cancel', id: 'f1a2' });
});

test('文件回执和 file-caps', () => {
  assert.deepEqual(
    parseFileReply(
      '{"t":"file-ok","id":"f1","path":"C:\\\\Users\\\\a\\\\Downloads\\\\RemoteClaude\\\\x (1).pdf","name":"x (1).pdf","pasted":true}',
    ),
    { id: 'f1', path: 'C:\\Users\\a\\Downloads\\RemoteClaude\\x (1).pdf', name: 'x (1).pdf', pasted: true, code: null },
  );
  // 存下了但没粘贴上
  assert.deepEqual(
    parseFileReply('{"t":"file-ok","id":"f1","path":"C:\\\\d\\\\x.pdf","name":"x.pdf","pasted":false,"code":"locked"}'),
    { id: 'f1', path: 'C:\\d\\x.pdf', name: 'x.pdf', pasted: false, code: 'locked' },
  );
  // 没粘贴上又没给原因，当作 failed
  assert.equal(parseFileReply('{"t":"file-ok","id":"f1","path":"C:\\\\d\\\\x.pdf","pasted":false}')?.code, 'failed');
  assert.deepEqual(parseFileReply('{"t":"err","code":"disk-full","id":"f1"}'), {
    id: 'f1',
    path: null,
    name: null,
    pasted: false,
    code: 'disk-full',
  });
  assert.equal(parseFileReply('{"t":"file-ok","id":"f1"}'), null);
  assert.equal(parseFileReply('{"t":"err","code":"covered"}'), null);

  assert.deepEqual(parseChannelMessage('{"t":"file-caps","max":52428800}'), { t: 'file-caps', max: 52_428_800 });
  assert.equal(parseChannelMessage('{"t":"file-caps"}'), null);
  assert.equal(parseChannelMessage('{"t":"file-caps","max":0}'), null);
  // 别的消息不会被当成 file-caps
  assert.equal(parseChannelMessage('{"t":"tile-state","available":true}')?.t, 'tile-state');
});

test('图片回执', () => {
  assert.deepEqual(parseChannelMessage('{"t":"img-ok","id":"k3f9a2"}'), {
    t: 'image-reply',
    reply: { id: 'k3f9a2', code: null },
  });
  assert.deepEqual(parseChannelMessage('{"t":"err","code":"image-bad","id":"k3f9a2"}'), {
    t: 'image-reply',
    reply: { id: 'k3f9a2', code: 'image-bad' },
  });
  // 不带 id 的错误是普通输入错误
  assert.deepEqual(parseChannelMessage('{"t":"err","code":"covered"}'), { t: 'err', code: 'covered', detail: null });
  assert.equal(parseChannelMessage('{"t":"img-ok"}'), null);
});

test('锁定和解锁消息符合 4.6 节', () => {
  assert.deepEqual(parseChannelMessage('{"t":"lock","locked":true,"unlock":false}'), {
    t: 'lock',
    state: { locked: true, unlockAvailable: false, unlockUntrusted: false },
  });
  assert.deepEqual(parseChannelMessage('{"t":"lock","locked":false,"unlock":true}'), {
    t: 'lock',
    state: { locked: false, unlockAvailable: true, unlockUntrusted: false },
  });
  // 解锁服务核实不过（旧版要重新安装）：和"没装"分开；能解锁时 untrusted 不算数
  assert.deepEqual(parseChannelMessage('{"t":"lock","locked":true,"unlock":false,"untrusted":true}'), {
    t: 'lock',
    state: { locked: true, unlockAvailable: false, unlockUntrusted: true },
  });
  assert.deepEqual(parseChannelMessage('{"t":"lock","locked":true,"unlock":true,"untrusted":true}'), {
    t: 'lock',
    state: { locked: true, unlockAvailable: true, unlockUntrusted: false },
  });

  assert.deepEqual(parseChannelMessage('{"t":"unlock-result","id":"u1","ok":true}'), {
    t: 'unlock-result',
    result: { id: 'u1', code: null },
  });
  assert.deepEqual(parseChannelMessage('{"t":"unlock-result","id":"u1","ok":false,"code":"still-locked"}'), {
    t: 'unlock-result',
    result: { id: 'u1', code: 'still-locked' },
  });
  assert.deepEqual(parseChannelMessage('{"t":"unlock-result","id":"u1","ok":false}'), {
    t: 'unlock-result',
    result: { id: 'u1', code: 'failed' },
  });
  assert.equal(parseChannelMessage('{"t":"unlock-result","ok":true}'), null);

  assert.deepEqual(parseChannelMessage('{"t":"tile-state","available":true,"paused":true}'), {
    t: 'tile-state',
    state: { available: true, paused: true },
  });
  assert.deepEqual(obj(tileEvent('arrange')), { t: 'tile', op: 'arrange' });
  assert.deepEqual(obj(lockNowEvent()), { t: 'lock-now' });
  assert.deepEqual(obj(unlockEvent('u1', 'p@ss 中文"引号')), { t: 'unlock', id: 'u1', p: 'p@ss 中文"引号' });
});

test('审批消息符合 2.7 节', () => {
  const list = parseAs(
    `{"type":"approvals","host":"pc-1","list":[
      {"id":"aaaa","kind":"permission","title":"会话","cwd":"F:\\\\p","agent":"","tool":"Bash","description":"删目录",
       "params":[{"key":"command","value":"rm -rf build"}],"complete":false,"questions":[],"createdAt":5},
      {"id":"bbbb","kind":"ask","title":"t","questions":[{"question":"选哪个？","header":"方案","multiSelect":true,
       "options":[{"label":"A","description":"甲"}]}]},
      {"kind":"ask"}]}`,
    'approvals',
  );
  assert.equal(list.host, 'pc-1');
  assert.equal(list.list.length, 2);
  const p = list.list[0];
  assert.equal(p.kind, 'permission');
  assert.equal(p.cwd, 'F:\\p');
  assert.deepEqual(p.params, [{ key: 'command', value: 'rm -rf build' }]);
  assert.equal(p.complete, false);
  assert.equal(p.createdAt, 5);
  const q = list.list[1];
  assert.equal(q.kind, 'ask');
  assert.equal(q.complete, true);
  assert.deepEqual(q.questions[0], {
    question: '选哪个？',
    header: '方案',
    multiSelect: true,
    options: [{ label: 'A', description: '甲' }],
  });

  const allow = obj(approvalAnswerMessage('pc-1', 'aaaa', 'r1', 'allow', '', null));
  assert.equal(allow['type'], 'approval-answer');
  assert.equal(allow['choice'], 'allow');
  assert.ok(!('answers' in allow));
  const ans = obj(approvalAnswerMessage('pc-1', 'bbbb', 'r2', 'allow', '', { '单选？': 'A', '多选？': ['甲', '乙'] }));
  assert.deepEqual(ans['answers'], { '单选？': 'A', '多选？': ['甲', '乙'] });

  assert.deepEqual(parseIncoming('{"type":"approval-result","host":"pc-1","id":"aaaa","req":"r1","ok":false,"code":"gone"}'), {
    type: 'approval-result',
    host: 'pc-1',
    id: 'aaaa',
    req: 'r1',
    ok: false,
    code: 'gone',
  });
});

test('升级相关消息', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(
    parseAppUpdate(
      `{"package":"com.remoteclaude.android","versionCode":8,"versionName":"0.7.0","notes":"修了些问题","size":1234,"sha256":"${sha.toUpperCase()}","url":"/download/android/RemoteClaude-0.7.0.apk"}`,
    ),
    {
      packageName: 'com.remoteclaude.android',
      versionCode: 8,
      versionName: '0.7.0',
      notes: '修了些问题',
      size: 1234,
      sha256: sha,
      url: '/download/android/RemoteClaude-0.7.0.apk',
    },
  );
  // 没有哈希、地址不是本服务器的下载路径、没有包名，都不认
  assert.equal(parseAppUpdate('{"package":"p","versionCode":8,"url":"/download/android/x.apk"}'), null);
  assert.equal(parseAppUpdate(`{"package":"p","versionCode":8,"sha256":"${sha}","url":"https://evil.example/x.apk"}`), null);
  assert.equal(parseAppUpdate(`{"versionCode":8,"sha256":"${sha}","url":"/download/android/x.apk"}`), null);

  assert.deepEqual(obj(hostUpdateMessage('pc-1', 'install')), { type: 'host-update', host: 'pc-1', op: 'install' });
  assert.deepEqual(
    parseIncoming('{"type":"host-update-state","host":"pc-1","version":"0.7.0","status":"downloading","newVersion":"0.7.1","percent":35}'),
    { type: 'host-update-state', host: 'pc-1', state: { version: '0.7.0', status: 'downloading', newVersion: '0.7.1', percent: 35 } },
  );
  // 百分比限制在 0 到 100
  const over = parseAs('{"type":"host-update-state","host":"pc-1","percent":250}', 'host-update-state');
  assert.equal(over.state.percent, 100);
  assert.equal(over.state.status, 'idle');
});

test('会话消息符合 2.5 节', () => {
  assert.deepEqual(obj(listSessionsMessage('pc-1')), { type: 'list-sessions', host: 'pc-1' });
  assert.deepEqual(obj(openSessionMessage('pc-1', 'local_ab-12', 's1')), {
    type: 'open-session',
    host: 'pc-1',
    session: 'local_ab-12',
    req: 's1',
  });
  assert.deepEqual(obj(newSessionMessage('pc-1', 'env-9', 's2')), { type: 'new-session', host: 'pc-1', env: 'env-9', req: 's2' });

  const sessions = parseAs(
    `{"type":"sessions","host":"pc-1","available":true,"groups":[
      {"key":"env:e1","name":"RemoteClaude","folder":"F:\\\\SVN\\\\RC","env":"e1","sessions":[
        {"id":"local_1","title":"远程控制","at":1795051127204,"open":true},{"title":"缺 id 的跳过"}]},
      {"key":"dir:x","name":"GitProjects","folder":"E:\\\\Git","env":null,"sessions":[]},
      {"name":"缺 key 的组跳过"}]}`,
    'sessions',
  );
  assert.equal(sessions.host, 'pc-1');
  assert.equal(sessions.available, true);
  assert.deepEqual(sessions.groups, [
    {
      key: 'env:e1',
      name: 'RemoteClaude',
      folder: 'F:\\SVN\\RC',
      env: 'e1',
      sessions: [{ id: 'local_1', title: '远程控制', at: 1795051127204, open: true }],
    },
    { key: 'dir:x', name: 'GitProjects', folder: 'E:\\Git', env: null, sessions: [] },
  ]);
  const none = parseAs('{"type":"sessions","host":"pc-1","available":false,"reason":"no-claude","groups":[]}', 'sessions');
  assert.equal(none.reason, 'no-claude');
  assert.equal(none.available, false);

  assert.deepEqual(
    parseIncoming('{"type":"session-opened","host":"pc-1","req":"s2","hwnd":42,"title":"新会话","created":true,"envOk":false}'),
    { type: 'session-opened', host: 'pc-1', req: 's2', hwnd: 42, title: '新会话', created: true, envOk: false },
  );
  // 打开已有会话的回执不带 envOk，当作选好了
  assert.deepEqual(parseIncoming('{"type":"session-opened","host":"pc-1","req":"s1","hwnd":7,"title":"t","created":false}'), {
    type: 'session-opened',
    host: 'pc-1',
    req: 's1',
    hwnd: 7,
    title: 't',
    created: false,
    envOk: true,
  });
  assert.equal(parseIncoming('{"type":"session-opened","host":"pc-1","req":"s1"}'), null);
  assert.deepEqual(parseIncoming('{"type":"session-failed","host":"pc-1","req":"s1","code":"locked"}'), {
    type: 'session-failed',
    host: 'pc-1',
    req: 's1',
    code: 'locked',
  });
});

test('关闭窗口的消息', () => {
  // 0.9.1 起的被控端在窗口列表里标出能不能关；旧版本没有这个字段，解析成 null
  const list = parseAs(
    `{"type":"windows","host":"pc-1","list":[
      {"hwnd":1,"title":"Claude","minimized":false,"width":900,"height":700,"thumb":null,"closable":false},
      {"hwnd":2,"title":"通知声音提醒功能","minimized":false,"width":850,"height":1391,"thumb":null,"closable":true},
      {"hwnd":3,"title":"旧被控端","minimized":false,"width":850,"height":1391,"thumb":null}]}`,
    'windows',
  );
  assert.deepEqual(
    list.list.map((w) => w.closable),
    [false, true, null],
  );

  assert.deepEqual(obj(closeWindowMessage('pc-1', 4524954, '已打开卡片加关闭按钮', 'c3')), {
    type: 'close-window',
    host: 'pc-1',
    hwnd: 4524954,
    title: '已打开卡片加关闭按钮',
    req: 'c3',
  });

  assert.deepEqual(parseIncoming('{"type":"close-window-result","host":"pc-1","req":"c3","hwnd":4524954,"ok":true}'), {
    type: 'close-window-result',
    host: 'pc-1',
    req: 'c3',
    hwnd: 4524954,
    ok: true,
    code: '',
  });
  assert.deepEqual(parseIncoming('{"type":"close-window-result","host":"pc-1","req":"c4","hwnd":9,"ok":false,"code":"changed"}'), {
    type: 'close-window-result',
    host: 'pc-1',
    req: 'c4',
    hwnd: 9,
    ok: false,
    code: 'changed',
  });
  // 失败却没给原因的，当作 failed
  assert.deepEqual(parseIncoming('{"type":"close-window-result","host":"pc-1","req":"c5","ok":false}'), {
    type: 'close-window-result',
    host: 'pc-1',
    req: 'c5',
    hwnd: 0,
    ok: false,
    code: 'failed',
  });
});

test('host-state 和不连画面的命令符合 2.9 节', () => {
  assert.deepEqual(
    parseIncoming('{"type":"host-state","host":"pc-1","lock":{"locked":true,"unlock":true},"tile":{"available":true,"paused":false},"key":"MIIB"}'),
    {
      type: 'host-state',
      host: 'pc-1',
      state: { lock: { locked: true, unlockAvailable: true, unlockUntrusted: false }, tile: { available: true, paused: false }, key: 'MIIB' },
    },
  );
  // 被控端刚启动、公钥还没生成好时不带 key；缺的字段都当 false
  assert.deepEqual(parseIncoming('{"type":"host-state","host":"pc-1","lock":{"locked":false},"key":""}'), {
    type: 'host-state',
    host: 'pc-1',
    state: { lock: { locked: false, unlockAvailable: false, unlockUntrusted: false }, tile: { available: false, paused: false }, key: null },
  });
  assert.deepEqual(parseAs('{"type":"host-state","host":"pc-1","lock":{"locked":true,"unlock":false,"untrusted":true}}', 'host-state').state.lock, {
    locked: true,
    unlockAvailable: false,
    unlockUntrusted: true,
  });
  assert.deepEqual(parseAs('{"type":"host-state","host":"pc-1","tile":{"paused":true}}', 'host-state').state.tile, {
    available: false,
    paused: true,
  });

  const arrange = obj(hostCmdMessage('pc-1', 'arrange'));
  assert.deepEqual(Object.keys(arrange).sort(), ['host', 'op', 'type']);
  assert.deepEqual(arrange, { type: 'host-cmd', host: 'pc-1', op: 'arrange' });
  const unlock = obj(hostCmdMessage('pc-1', 'unlock', 'u1', 'QUJD'));
  assert.deepEqual([unlock['op'], unlock['req'], unlock['enc']], ['unlock', 'u1', 'QUJD']);

  assert.deepEqual(parseIncoming('{"type":"host-cmd-result","host":"pc-1","req":"u1","op":"unlock","ok":true}'), {
    type: 'host-cmd-result',
    host: 'pc-1',
    req: 'u1',
    op: 'unlock',
    ok: true,
    code: '',
  });
  assert.deepEqual(parseIncoming('{"type":"host-cmd-result","host":"pc-1","req":"u2","op":"unlock","ok":false,"code":"still-locked"}'), {
    type: 'host-cmd-result',
    host: 'pc-1',
    req: 'u2',
    op: 'unlock',
    ok: false,
    code: 'still-locked',
  });
  assert.deepEqual(parseIncoming('{"type":"host-cmd-result","host":"pc-1","req":"u3","ok":false}'), {
    type: 'host-cmd-result',
    host: 'pc-1',
    req: 'u3',
    op: '',
    ok: false,
    code: 'failed',
  });
});

test('推送令牌登记', () => {
  assert.deepEqual(obj(pushRegisterMessage('tk')), { type: 'push-register', platform: 'harmony', token: 'tk' });
  assert.deepEqual(obj(pushUnregisterMessage('tk')), { type: 'push-unregister', token: 'tk' });
  assert.deepEqual(parseIncoming('{"type":"push-register-result","ok":true}'), { type: 'push-register-result', ok: true, code: '' });
  assert.deepEqual(parseIncoming('{"type":"push-register-result","ok":false}'), {
    type: 'push-register-result',
    ok: false,
    code: 'failed',
  });
});
