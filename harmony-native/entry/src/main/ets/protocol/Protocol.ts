/**
 * 与信令服务器、被控端之间的消息格式。全部约定见 docs/03-protocol.md（协议版本 2）。
 * 对照安卓端 android/.../protocol/Protocol.kt 移植。
 *
 * 这个文件是普通 TypeScript，不依赖鸿蒙的接口，可以在电脑上用 node 跑单元测试（harmony-native/test）。
 * 解析动态 JSON 在 ArkTS 里很别扭（不允许 any），所以放在 .ts 里，ArkTS 页面只拿解析好的强类型结果。
 */

export const PROTOCOL_VERSION = 2;

export interface IceServerSpec {
  urls: string[];
  username?: string;
  credential?: string;
}

/** ICE 候选，字段名和 W3C 的 RTCIceCandidateInit 一致 */
export interface IceCandidateSpec {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number;
}

/** 账号下的一台电脑（被控端） */
export interface HostInfo {
  id: string;
  name: string;
  online: boolean;
}

export interface RemoteWindow {
  hwnd: number;
  title: string;
  minimized: boolean;
  width: number;
  height: number;
  /** JPEG 缩略图的 data URL，取不到时为 null */
  thumb: string | null;
  /** 能不能从手机关掉这个窗口（协议 2.8）。为 null 表示被控端是旧版本，不认关闭窗口 */
  closable: boolean | null;
}

/** 电脑上 Claude 桌面端的一个会话（协议 2.5）；open 表示已经开成了单独窗口 */
export interface SessionEntry {
  id: string;
  title: string;
  at: number;
  open: boolean;
}

/** 一组会话：一个环境，或者一个没有对应环境的工作目录（env 为 null，不能在这组里新建） */
export interface SessionGroup {
  key: string;
  name: string;
  folder: string;
  env: string | null;
  sessions: SessionEntry[];
}

/** 电脑被控端的版本和升级状态（协议 2.6） */
export interface HostUpdateState {
  version: string;
  status: string;
  newVersion: string;
  percent: number;
}

export interface ApprovalParam {
  key: string;
  value: string;
}

export interface ApprovalOption {
  label: string;
  description: string;
}

export interface ApprovalQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: ApprovalOption[];
}

/** 电脑上等手机作答的一条审批或提问（协议 2.7，docs/09） */
export interface Approval {
  id: string;
  /** permission：审批工具调用；ask：Claude 的提问 */
  kind: string;
  title: string;
  cwd: string;
  agent: string;
  tool: string;
  description: string;
  params: ApprovalParam[];
  /** 为 false 表示有参数太长被截掉了 */
  complete: boolean;
  questions: ApprovalQuestion[];
  createdAt: number;
}

export interface LockState {
  locked: boolean;
  /** 电脑上装了解锁服务 */
  unlockAvailable: boolean;
  /** 电脑上有解锁服务，但被控端核实不过它（多半是旧版服务，要在电脑上重新安装）；unlockAvailable 为 true 时总是 false */
  unlockUntrusted: boolean;
}

export interface TileState {
  available: boolean;
  paused: boolean;
}

/** 电脑经信令通道推来的状态（协议 2.9）；key 是不连画面解锁时加密密码用的公钥（DER 的 Base64） */
export interface HostState {
  lock: LockState;
  tile: TileState;
  key: string | null;
}

/** 被控端对一张图片的回执；code 为 null 表示已经粘贴进去 */
export interface ImageReply {
  id: string;
  code: string | null;
}

/**
 * 被控端对一个文件的回执。path 不为 null 表示文件已经存到电脑上（name 是实际存的文件名），
 * 这时 pasted 说明路径粘贴上没有，没粘贴上时 code 是原因；path 为 null 表示没存下，code 是错误码
 */
export interface FileReply {
  id: string;
  path: string | null;
  name: string | null;
  pasted: boolean;
  code: string | null;
}

export interface UnlockResult {
  id: string;
  code: string | null;
}

/** 电脑上新复制的一段文字的其中一块（协议 4.9） */
export interface ClipChunk {
  id: string;
  index: number;
  count: number;
  text: string;
}

/** 服务器上发布的最新安装包（协议 1.7） */
export interface AppUpdateInfo {
  packageName: string;
  versionCode: number;
  versionName: string;
  notes: string;
  size: number;
  sha256: string;
  url: string;
}

/** 窗口列表分两次回时的标记（协议 2.4） */
export const THUMBS_PENDING = 'pending';
export const THUMBS_DONE = 'done';

/** 从信令通道收到的消息。电脑发来的消息都带 host，表示来自哪台电脑 */
export type Incoming =
  | { type: 'auth-ok'; id: string; email: string; iceServers: IceServerSpec[]; hosts: HostInfo[] }
  | { type: 'auth-fail'; reason: string }
  | { type: 'hosts'; hosts: HostInfo[] }
  | { type: 'windows'; host: string; list: RemoteWindow[]; thumbs: string | null }
  | { type: 'offer'; host: string; sdp: string; hwnd: number; title: string }
  | { type: 'ice'; host: string; candidate: IceCandidateSpec }
  | { type: 'selected'; host: string; hwnd: number; title: string }
  | { type: 'window-closed'; host: string }
  | { type: 'error'; host: string; code: string }
  | { type: 'sessions'; host: string; available: boolean; reason: string | null; groups: SessionGroup[] }
  | { type: 'session-opened'; host: string; req: string; hwnd: number; title: string; created: boolean; envOk: boolean }
  | { type: 'session-failed'; host: string; req: string; code: string }
  | { type: 'close-window-result'; host: string; req: string; hwnd: number; ok: boolean; code: string }
  | { type: 'host-update-state'; host: string; state: HostUpdateState }
  | { type: 'approvals'; host: string; list: Approval[] }
  | { type: 'approval-result'; host: string; id: string; req: string; ok: boolean; code: string }
  | { type: 'host-state'; host: string; state: HostState }
  | { type: 'host-cmd-result'; host: string; req: string; op: string; ok: boolean; code: string }
  | { type: 'push-register-result'; ok: boolean; code: string };

type Json = Record<string, unknown>;

// ------------------------------------------------------------------ 解析辅助

export function parseObject(text: string): Json | null {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

function str(o: Json, key: string): string | null {
  const v = o[key];
  return typeof v === 'string' ? v : null;
}

function bool(o: Json, key: string): boolean | null {
  const v = o[key];
  return typeof v === 'boolean' ? v : null;
}

function num(o: Json, key: string): number | null {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

function obj(o: Json, key: string): Json | null {
  const v = o[key];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function arr(o: Json, key: string): unknown[] {
  const v = o[key];
  return Array.isArray(v) ? v : [];
}

/** 协议 2.9 host-state 的 lock、4.6 的 lock 消息 */
function lockStateOf(o: Json | null): LockState {
  const unlock = o !== null && bool(o, 'unlock') === true;
  return {
    locked: o !== null && bool(o, 'locked') === true,
    unlockAvailable: unlock,
    unlockUntrusted: !unlock && o !== null && bool(o, 'untrusted') === true,
  };
}

function asObj(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function mapObjects<T>(items: unknown[], fn: (o: Json) => T | null): T[] {
  const out: T[] = [];
  for (const item of items) {
    const o = asObj(item);
    if (o === null) continue;
    const r = fn(o);
    if (r !== null) out.push(r);
  }
  return out;
}

function parseHosts(items: unknown[]): HostInfo[] {
  return mapObjects(items, (o) => {
    const id = str(o, 'id');
    if (id === null) return null;
    return { id, name: str(o, 'name') || '电脑', online: bool(o, 'online') === true };
  });
}

function parseIceServers(items: unknown[]): IceServerSpec[] {
  return mapObjects(items, (o) => {
    const u = o['urls'];
    let urls: string[] = [];
    if (typeof u === 'string') urls = [u];
    else if (Array.isArray(u)) urls = u.filter((x): x is string => typeof x === 'string');
    if (urls.length === 0) return null;
    const spec: IceServerSpec = { urls };
    const username = str(o, 'username');
    const credential = str(o, 'credential');
    if (username !== null) spec.username = username;
    if (credential !== null) spec.credential = credential;
    return spec;
  });
}

function parseCandidate(o: Json | null): IceCandidateSpec | null {
  if (o === null) return null;
  const candidate = str(o, 'candidate');
  if (candidate === null) return null;
  return { candidate, sdpMid: str(o, 'sdpMid'), sdpMLineIndex: num(o, 'sdpMLineIndex') ?? 0 };
}

function parseWindow(o: Json): RemoteWindow | null {
  const hwnd = num(o, 'hwnd');
  if (hwnd === null) return null;
  const thumb = str(o, 'thumb');
  return {
    hwnd,
    title: str(o, 'title') ?? '',
    minimized: bool(o, 'minimized') === true,
    width: num(o, 'width') ?? 0,
    height: num(o, 'height') ?? 0,
    thumb: thumb !== null && thumb.startsWith('data:image/') ? thumb : null,
    closable: bool(o, 'closable'),
  };
}

function parseGroup(o: Json): SessionGroup | null {
  const key = str(o, 'key');
  if (key === null) return null;
  const sessions = mapObjects(arr(o, 'sessions'), (s): SessionEntry | null => {
    const id = str(s, 'id');
    if (id === null) return null;
    return { id, title: str(s, 'title') ?? '', at: num(s, 'at') ?? 0, open: bool(s, 'open') === true };
  });
  const env = str(o, 'env');
  return { key, name: str(o, 'name') ?? '', folder: str(o, 'folder') ?? '', env: env ? env : null, sessions };
}

function parseApproval(o: Json): Approval | null {
  const id = str(o, 'id');
  if (id === null) return null;
  return {
    id,
    kind: str(o, 'kind') === 'ask' ? 'ask' : 'permission',
    title: str(o, 'title') ?? '',
    cwd: str(o, 'cwd') ?? '',
    agent: str(o, 'agent') ?? '',
    tool: str(o, 'tool') ?? '',
    description: str(o, 'description') ?? '',
    params: mapObjects(arr(o, 'params'), (p): ApprovalParam => ({ key: str(p, 'key') ?? '', value: str(p, 'value') ?? '' })),
    complete: bool(o, 'complete') !== false,
    questions: mapObjects(arr(o, 'questions'), (q): ApprovalQuestion => ({
      question: str(q, 'question') ?? '',
      header: str(q, 'header') ?? '',
      multiSelect: bool(q, 'multiSelect') === true,
      options: mapObjects(arr(q, 'options'), (op): ApprovalOption => ({
        label: str(op, 'label') ?? '',
        description: str(op, 'description') ?? '',
      })),
    })),
    createdAt: num(o, 'createdAt') ?? 0,
  };
}

/** 解析一条信令消息；格式不对或类型未知时返回 null */
export function parseIncoming(text: string): Incoming | null {
  const o = parseObject(text);
  if (o === null) return null;
  const host = str(o, 'host') ?? '';
  switch (str(o, 'type')) {
    case 'auth-ok':
      return {
        type: 'auth-ok',
        id: str(o, 'id') ?? '',
        email: str(o, 'email') ?? '',
        iceServers: parseIceServers(arr(o, 'iceServers')),
        hosts: parseHosts(arr(o, 'hosts')),
      };
    case 'auth-fail':
      return { type: 'auth-fail', reason: str(o, 'reason') ?? 'unknown' };
    case 'hosts':
      return { type: 'hosts', hosts: parseHosts(arr(o, 'hosts')) };
    case 'windows':
      return { type: 'windows', host, list: mapObjects(arr(o, 'list'), parseWindow), thumbs: str(o, 'thumbs') };
    case 'offer': {
      const sdpObj = obj(o, 'sdp');
      const sdp = sdpObj === null ? null : str(sdpObj, 'sdp');
      if (sdp === null) return null;
      return { type: 'offer', host, sdp, hwnd: num(o, 'hwnd') ?? 0, title: str(o, 'title') ?? '' };
    }
    case 'ice': {
      const candidate = parseCandidate(obj(o, 'candidate'));
      return candidate === null ? null : { type: 'ice', host, candidate };
    }
    case 'selected':
      return { type: 'selected', host, hwnd: num(o, 'hwnd') ?? 0, title: str(o, 'title') ?? '' };
    case 'window-closed':
      return { type: 'window-closed', host };
    case 'error':
      return { type: 'error', host, code: str(o, 'code') ?? 'unknown' };
    case 'sessions':
      return {
        type: 'sessions',
        host,
        available: bool(o, 'available') === true,
        reason: str(o, 'reason'),
        groups: mapObjects(arr(o, 'groups'), parseGroup),
      };
    case 'session-opened': {
      const hwnd = num(o, 'hwnd');
      if (hwnd === null) return null;
      return {
        type: 'session-opened',
        host,
        req: str(o, 'req') ?? '',
        hwnd,
        title: str(o, 'title') ?? '',
        created: bool(o, 'created') === true,
        envOk: bool(o, 'envOk') !== false,
      };
    }
    case 'session-failed':
      return { type: 'session-failed', host, req: str(o, 'req') ?? '', code: str(o, 'code') ?? 'failed' };
    case 'close-window-result': {
      const ok = bool(o, 'ok') === true;
      return {
        type: 'close-window-result',
        host,
        req: str(o, 'req') ?? '',
        hwnd: num(o, 'hwnd') ?? 0,
        ok,
        code: ok ? '' : str(o, 'code') ?? 'failed',
      };
    }
    case 'approvals':
      return { type: 'approvals', host, list: mapObjects(arr(o, 'list'), parseApproval) };
    case 'approval-result':
      return {
        type: 'approval-result',
        host,
        id: str(o, 'id') ?? '',
        req: str(o, 'req') ?? '',
        ok: bool(o, 'ok') === true,
        code: str(o, 'code') ?? '',
      };
    case 'host-update-state':
      return {
        type: 'host-update-state',
        host,
        state: {
          version: str(o, 'version') ?? '',
          status: str(o, 'status') ?? 'idle',
          newVersion: str(o, 'newVersion') ?? '',
          percent: Math.min(100, Math.max(0, num(o, 'percent') ?? 0)),
        },
      };
    case 'host-state': {
      const lock = obj(o, 'lock');
      const tile = obj(o, 'tile');
      const key = str(o, 'key');
      return {
        type: 'host-state',
        host,
        state: {
          lock: lockStateOf(lock),
          tile: {
            available: tile !== null && bool(tile, 'available') === true,
            paused: tile !== null && bool(tile, 'paused') === true,
          },
          key: key ? key : null,
        },
      };
    }
    case 'host-cmd-result': {
      const ok = bool(o, 'ok') === true;
      return {
        type: 'host-cmd-result',
        host,
        req: str(o, 'req') ?? '',
        op: str(o, 'op') ?? '',
        ok,
        code: ok ? '' : str(o, 'code') ?? 'failed',
      };
    }
    case 'push-register-result': {
      const ok = bool(o, 'ok') === true;
      // 协议 2.10：失败原因在 error 字段
      return { type: 'push-register-result', ok, code: ok ? '' : str(o, 'error') ?? str(o, 'code') ?? 'failed' };
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------------ 数据通道上被控端发来的消息（协议第 4、5 节）

/** 数据通道 input 上收到的一条消息，解析成哪一种 */
export type ChannelMessage =
  | { t: 'clip'; chunk: ClipChunk }
  | { t: 'clip-skip'; code: string }
  | { t: 'lock'; state: LockState }
  | { t: 'tile-state'; state: TileState }
  | { t: 'unlock-result'; result: UnlockResult }
  | { t: 'image-reply'; reply: ImageReply }
  | { t: 'file-caps'; max: number }
  | { t: 'err'; code: string; detail: string | null };

/** 输入错误的补充说明最多显示这么多个字符 */
export const DETAIL_MAX = 200;

/** 被控端写的补充说明：去掉控制字符和首尾空白，最多 DETAIL_MAX 个字符，空的当作没有 */
function cleanDetail(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const text = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, DETAIL_MAX);
  return text.length > 0 ? text : null;
}

/**
 * 按错误码翻好的提示后面接上被控端的补充说明（协议第 5 节的 detail，被控端 0.9.30 起，
 * 比如切不到前台时挡在最前面的是谁）；没有说明时提示不变
 */
export function withDetail(text: string, detail: string | null): string {
  return detail === null ? text : `${text}：${detail}`;
}

/** 剪贴板分块的上限，见 ClipAssembler */
export const CLIP_MAX_CHUNKS = 256;

/** 解析 input 通道上被控端发来的一条消息；不认识的返回 null */
export function parseChannelMessage(text: string): ChannelMessage | null {
  const o = parseObject(text);
  if (o === null) return null;
  const t = str(o, 't');
  switch (t) {
    case 'clip': {
      const id = str(o, 'id');
      const count = num(o, 'n');
      const index = num(o, 'i');
      const s = str(o, 's');
      if (id === null || id.length === 0 || id.length > 32 || count === null || index === null || s === null) return null;
      if (count < 1 || count > CLIP_MAX_CHUNKS || index < 0 || index >= count) return null;
      return { t: 'clip', chunk: { id, index, count, text: s } };
    }
    case 'clip-skip':
      return { t: 'clip-skip', code: str(o, 'code') ?? 'unknown' };
    case 'lock':
      return { t: 'lock', state: lockStateOf(o) };
    case 'tile-state':
      return { t: 'tile-state', state: { available: bool(o, 'available') === true, paused: bool(o, 'paused') === true } };
    case 'unlock-result': {
      const id = str(o, 'id');
      if (id === null) return null;
      return { t: 'unlock-result', result: { id, code: bool(o, 'ok') === true ? null : str(o, 'code') ?? 'failed' } };
    }
    case 'img-ok': {
      const id = str(o, 'id');
      return id === null ? null : { t: 'image-reply', reply: { id, code: null } };
    }
    case 'file-caps': {
      const max = num(o, 'max');
      return max !== null && max > 0 ? { t: 'file-caps', max } : null;
    }
    case 'err': {
      const code = str(o, 'code') ?? 'unknown';
      const id = str(o, 'id');
      // 带 id 的是图片的错误回执（协议 4.5），不带的是一般的输入错误（第 5 节）
      return id !== null ? { t: 'image-reply', reply: { id, code } } : { t: 'err', code, detail: cleanDetail(str(o, 'detail')) };
    }
    default:
      return null;
  }
}

/** file 通道上被控端对一个文件的回执（协议 4.8）；不是文件回执时返回 null */
export function parseFileReply(text: string): FileReply | null {
  const o = parseObject(text);
  if (o === null) return null;
  const id = str(o, 'id');
  if (id === null) return null;
  switch (str(o, 't')) {
    case 'file-ok': {
      const path = str(o, 'path');
      if (path === null) return null;
      const pasted = bool(o, 'pasted') === true;
      return { id, path, name: str(o, 'name'), pasted, code: pasted ? null : str(o, 'code') ?? 'failed' };
    }
    case 'err':
      return { id, path: null, name: null, pasted: false, code: str(o, 'code') ?? 'unknown' };
    default:
      return null;
  }
}

/** 解析 GET /api/update/... 的回复；格式不对返回 null */
export function parseAppUpdate(text: string): AppUpdateInfo | null {
  const o = parseObject(text);
  if (o === null) return null;
  const versionCode = num(o, 'versionCode');
  const url = str(o, 'url');
  const sha = (str(o, 'sha256') ?? '').toLowerCase();
  const pkg = str(o, 'package');
  if (versionCode === null || url === null || !url.startsWith('/download/') || !/^[0-9a-f]{64}$/.test(sha) || pkg === null) {
    return null;
  }
  return {
    packageName: pkg,
    versionCode,
    versionName: str(o, 'versionName') ?? '',
    notes: str(o, 'notes') ?? '',
    size: num(o, 'size') ?? 0,
    sha256: sha,
    url,
  };
}

// ------------------------------------------------------------------ 控制端发出的信令（协议 2.3 起）

export function authMessage(token: string, client: string): string {
  return JSON.stringify({ type: 'auth', role: 'viewer', token, proto: PROTOCOL_VERSION, client });
}

/** 要窗口列表。带 thumbs: "later"，0.9.7 起的被控端先回不带图的列表、再补带图的（协议 2.4） */
export function listMessage(host: string): string {
  return JSON.stringify({ type: 'list', host, thumbs: 'later' });
}

export function selectMessage(host: string, hwnd: number): string {
  return JSON.stringify({ type: 'select', host, hwnd });
}

export function answerMessage(host: string, sdp: string): string {
  return JSON.stringify({ type: 'answer', host, sdp: { type: 'answer', sdp } });
}

export function iceMessage(host: string, c: IceCandidateSpec): string {
  return JSON.stringify({
    type: 'ice',
    host,
    candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex },
  });
}

export function stopMessage(host: string): string {
  return JSON.stringify({ type: 'stop', host });
}

/**
 * 回答一条审批（协议 2.7）：choice 是 allow 或 deny；拒绝时 text 是说明；
 * 回答提问时 answers 是 问题原文 -> 选项（单选、自己填的文字）或选项列表（多选）
 */
export function approvalAnswerMessage(
  host: string,
  id: string,
  req: string,
  choice: string,
  text: string,
  answers: Record<string, string | string[]> | null,
): string {
  const m: Json = { type: 'approval-answer', host, id, req, choice, text };
  if (answers !== null) m['answers'] = answers;
  return JSON.stringify(m);
}

/** 电脑被控端升级：status、check、install（协议 2.6） */
export function hostUpdateMessage(host: string, op: string): string {
  return JSON.stringify({ type: 'host-update', host, op });
}

/** 不连画面的命令（协议 2.9）：arrange、raise、pause、resume、lock、unlock */
export function hostCmdMessage(host: string, op: string, req: string | null = null, enc: string | null = null): string {
  const m: Json = { type: 'host-cmd', host, op };
  if (req !== null) m['req'] = req;
  if (enc !== null) m['enc'] = enc;
  return JSON.stringify(m);
}

export function listSessionsMessage(host: string): string {
  return JSON.stringify({ type: 'list-sessions', host });
}

export function openSessionMessage(host: string, session: string, req: string): string {
  return JSON.stringify({ type: 'open-session', host, session, req });
}

export function newSessionMessage(host: string, env: string, req: string): string {
  return JSON.stringify({ type: 'new-session', host, env, req });
}

/** 关掉电脑上的一个会话窗口（协议 2.8），带上卡片上的标题，句柄换了会话时电脑不关 */
export function closeWindowMessage(host: string, hwnd: number, title: string, req: string): string {
  return JSON.stringify({ type: 'close-window', host, hwnd, title, req });
}

/** 登记华为 Push Kit 的推送令牌（协议 2.10）。每次鉴权成功后都发一次 */
export function pushRegisterMessage(token: string): string {
  return JSON.stringify({ type: 'push-register', platform: 'harmony', token });
}

export function pushUnregisterMessage(token: string): string {
  return JSON.stringify({ type: 'push-unregister', token });
}

// ------------------------------------------------------------------ 数据通道上发给被控端的输入事件（协议第 4 节）

export const BUTTON_LEFT = 0;
export const BUTTON_MIDDLE = 1;
export const BUTTON_RIGHT = 2;

export const MOD_CTRL = 1;
export const MOD_SHIFT = 2;
export const MOD_ALT = 4;

/** 坐标保留 5 位小数，足够区分 4K 窗口里的单个像素 */
function round5(v: number): number {
  return Math.round(v * 100000) / 100000;
}

export function moveEvent(x: number, y: number): string {
  return JSON.stringify({ t: 'm', x: round5(x), y: round5(y) });
}

export function downEvent(x: number, y: number, button: number): string {
  return JSON.stringify({ t: 'd', x: round5(x), y: round5(y), b: button });
}

export function upEvent(x: number, y: number, button: number): string {
  return JSON.stringify({ t: 'u', x: round5(x), y: round5(y), b: button });
}

export function wheelEvent(x: number, y: number, dx: number, dy: number): string {
  return JSON.stringify({ t: 'w', x: round5(x), y: round5(y), dx, dy });
}

export function keyEvent(key: string, mods: number): string {
  return JSON.stringify({ t: 'k', k: key, m: mods });
}

export function textEvent(s: string): string {
  return JSON.stringify({ t: 't', s });
}

export function imageBeginEvent(id: string, mime: string, size: number): string {
  return JSON.stringify({ t: 'img', id, mime, size });
}

export function imageEndEvent(id: string): string {
  return JSON.stringify({ t: 'img-end', id });
}

export function fileBeginEvent(id: string, name: string, size: number): string {
  return JSON.stringify({ t: 'file', id, name, size });
}

export function fileEndEvent(id: string, sha256: string): string {
  return JSON.stringify({ t: 'file-end', id, sha256 });
}

export function fileCancelEvent(id: string): string {
  return JSON.stringify({ t: 'file-cancel', id });
}

export function tileEvent(op: string): string {
  return JSON.stringify({ t: 'tile', op });
}

export function lockNowEvent(): string {
  return JSON.stringify({ t: 'lock-now' });
}

/** 解锁：password 是用户这次输入的 Windows 密码或 PIN，不保存 */
export function unlockEvent(id: string, password: string): string {
  return JSON.stringify({ t: 'unlock', id, p: password });
}
