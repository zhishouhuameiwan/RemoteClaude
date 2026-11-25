import webrtc, { VideoRenderController } from '@ohos/webrtc';
import { deviceInfo } from '@kit.BasicServicesKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { userAuth } from '@kit.UserAuthenticationKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import BuildProfile from 'BuildProfile';
import {
  Approval, FileReply, HostInfo, HostState, IceCandidateSpec, IceServerSpec, ImageReply, Incoming, LockState,
  RemoteWindow, SessionEntry, SessionGroup, THUMBS_DONE, THUMBS_PENDING, TileState, UnlockResult,
  answerMessage, approvalAnswerMessage, authMessage, closeWindowMessage, fileBeginEvent, fileCancelEvent, fileEndEvent,
  hostCmdMessage, hostUpdateMessage, iceMessage, imageBeginEvent, imageEndEvent, listMessage, listSessionsMessage,
  lockNowEvent, newSessionMessage, openSessionMessage, pushRegisterMessage, pushUnregisterMessage, selectMessage,
  stopMessage, tileEvent, unlockEvent, withDetail, BUTTON_LEFT, BUTTON_RIGHT
} from './protocol/Protocol';
import { parseServerAddress, restoreServerAddress, ServerAddressResult } from './protocol/ServerAddress';
import { UnlockCipher } from './protocol/UnlockCipher';
import { AuthApi, DeviceInfo } from './net/AuthApi';
import { SignalingClient } from './net/SignalingClient';
import { PeerSession } from './rtc/PeerSession';
import { readStats, StatsCursor } from './rtc/StatsReader';
import { AppSettings, SettingsStore } from './data/SettingsStore';
import {
  AppState, AuthMode, CatalogPhase, Link, ListTab, PendingApproval, RtcPhase, Screens, WindowItem
} from './model/AppState';
import { InputSender, RemotePoint } from './logic/InputSender';
import { HostCommands } from './logic/HostCommands';
import { WindowClose } from './logic/WindowClose';
import { FileUploads, StallWatch } from './logic/FileUploads';
import { FontZoom } from './logic/FontZoom';
import { ImagePrep, IMAGE_MAX_BYTES, PreparedImage } from './image/ImagePrep';
import { FileSource, FileTooLarge } from './files/FileSource';
import { BackgroundGuard } from './common/BackgroundGuard';
import { PushRegistrar } from './approvals/PushRegistrar';
import { Waiter, delay, shortId, withTimeout } from './common/Waiter';
import { Log, errText } from './common/Log';

const NOT_READY = '还没有连上画面';
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10000;
const REFRESH_TIMEOUT_MS = 6000;
/** 在后台超过这么久，回来时要重新验证身份 */
const LOCK_AFTER_MS = 30000;
/** 在选图界面里最多保持连接这么久 */
const PICK_GRACE_MS = 120000;
/** 正在发文件时切到后台，最多再保持连接这么久（实际受系统短时任务限制，约 3 分钟） */
const UPLOAD_GRACE_MS = 10 * 60000;
const FILE_CLOSED = '画面连接断开了，文件没有发完';
const IMAGE_CHUNK = 16 * 1024;
const MAX_BUFFERED = 256 * 1024;
const IMAGE_REPLY_TIMEOUT_MS = 20000;
const IMAGE_OK = 'ok';
const UNLOCK_REPLY_TIMEOUT_MS = 30000;
/** 电脑上打开会话最慢要等 Claude 启动、再点几级菜单 */
const OPEN_TIMEOUT_MS = 60000;
/** 画面连接 disconnected 持续这么久就重新要画面（协议第 3 节） */
const DISCONNECTED_GRACE_MS = 5000;

export const CLIENT_NAME = `harmony/${BuildProfile.VERSION_NAME}`;

/** 能不能在明文的 ws:// 上连：调试版可以，方便连局域网里的测试服务器 */
export const ALLOW_CLEARTEXT = BuildProfile.DEBUG;

/**
 * 整个控制端的状态机，对照安卓端 RemoteController.kt：账号、信令连接、电脑与窗口列表、画面连接、输入、
 * 传图传文件、锁定解锁、审批、前后台切换。进程里只有一个（controller），界面读 state。
 * 行为约定见 docs/04-android-client.md 的"生命周期与网络"一节，鸿蒙上的不同见 docs/10-harmony-client.md。
 */
export class RemoteController {
  readonly state: AppState = new AppState();
  /** 给用户看的短提示，页面挂上来显示 */
  toastSink: (text: string) => void = (text: string) => Log.i(`提示：${text}`);

  private api: AuthApi = new AuthApi();
  private signaling: SignalingClient;
  readonly input: InputSender;

  private loaded: boolean = false;
  private foreground: boolean = true;
  private wsUrl: string = '';
  private httpBase: string = '';
  /** 登录令牌；空串表示没登录 */
  private session: string = '';
  private deviceId: string = '';
  private authed: boolean = false;
  private iceServers: IceServerSpec[] = [];
  private backoffMs: number = INITIAL_BACKOFF_MS;
  private retryTimer: number = -1;
  private refreshTimer: number = -1;
  private catalogTimer: number = -1;
  private openTimer: number = -1;
  private logoutTimer: number = -1;
  private approvalsWaitTimer: number = -1;
  /** 服务器因为失败太多暂时锁了这个 IP（auth-fail locked）：这之前不要重连 */
  private reconnectNotBefore: number = 0;
  private openSeq: number = 0;
  private approvalSeq: number = 0;
  private approvalsByHost: Map<string, Approval[]> = new Map<string, Approval[]>();
  /** 发出去、还没收到回执的关闭窗口请求：req -> 窗口 */
  private closeRequests: Map<string, WindowItem> = new Map<string, WindowItem>();
  private closeSeq: number = 0;

  private peer: PeerSession | null = null;
  /** 当前画面连接来自哪台电脑 */
  private peerHost: string = '';
  private videoTrack: webrtc.MediaStreamTrack | null = null;
  private renderer: VideoRenderController | null = null;
  /** 想看的窗口：断线重连、回到前台、电脑重新上线后自动选回它；为 0 表示停在会话列表 */
  private wantHwnd: number = 0;
  private reselectTimer: number = -1;
  private statsTimer: number = -1;
  private statsCursor: StatsCursor = new StatsCursor();

  private backgroundSince: number = 0;
  /** 正在显示系统的身份验证界面，这期间不断线、不再上锁 */
  authenticating: boolean = false;
  /** 正在系统的选图、选文件界面里 */
  private picking: boolean = false;
  private pickGuardTimer: number = -1;
  /** 正在发图片或文件（同一时间只发一个） */
  private uploading: boolean = false;
  private uploadIsFile: boolean = false;
  private uploadCancelled: boolean = false;
  private imageWaiters: Map<string, Waiter<string>> = new Map<string, Waiter<string>>();
  private fileWaiters: Map<string, Waiter<FileReply>> = new Map<string, Waiter<FileReply>>();
  private unlockWaiters: Map<string, Waiter<string>> = new Map<string, Waiter<string>>();
  /** 各台电脑经信令通道推来的状态（协议 2.9） */
  private hostStates: Map<string, HostState> = new Map<string, HostState>();
  private hostCmdWaiters: Map<string, Waiter<string>> = new Map<string, Waiter<string>>();
  private hostCmdSeq: number = 0;
  /** 推送令牌：已经登记到服务器的那个 */
  private pushToken: string = '';
  /** 点推送通知打开 App 时要直接弹审批面板 */
  private approvalsRequested: boolean = false;

  constructor() {
    this.signaling = new SignalingClient({
      onOpen: () => this.sendAuth(),
      onMessage: (msg: Incoming) => this.handle(msg),
      onClosed: () => this.onSocketClosed()
    });
    this.input = new InputSender((text: string) => this.peer !== null && this.peer.sendInput(text));
  }

  // ------------------------------------------------------------------ 启动

  /** UIAbility 创建后调用一次：读出本地数据，登录过就连服务器 */
  load(): void {
    if (this.loaded) {
      return;
    }
    const stored = SettingsStore.load();
    // App 里不带服务器地址，只用手机上存的（登录成功时存下的那个，见 restoreServerAddress）
    const server = stored.server;
    const parsed = restoreServerAddress(server, ALLOW_CLEARTEXT);
    this.wsUrl = parsed !== null ? parsed.url : '';
    this.httpBase = parsed !== null ? parsed.httpBase : '';
    this.session = stored.session;
    this.deviceId = stored.deviceId;
    this.wantHwnd = stored.lastHwnd;
    this.pushToken = stored.pushToken;
    this.loaded = true;
    const canLock = this.deviceCanLock();
    const loggedIn = this.session.length > 0 && this.wsUrl.length > 0;
    const s = this.state;
    s.serverInput = server;
    // 登录过、却没存下能用的服务器地址：说明一下为什么又回到了登录页
    s.authError = this.session.length > 0 && this.wsUrl.length === 0 ? '请填写服务器地址后重新登录' : '';
    s.email = stored.email;
    s.hostId = stored.lastHost;
    s.settings = stored.settings;
    s.collapsedGroups = stored.collapsedGroups;
    s.canLock = canLock;
    s.locked = loggedIn && canLock && stored.settings.appLock;
    s.screen = loggedIn ? Screens.Sessions : Screens.Auth;
    this.connectIfLoggedIn();
  }

  // ------------------------------------------------------------------ 前后台与网络

  onForeground(): void {
    this.foreground = true;
    this.clearTimer(this.pickGuardTimer);
    this.pickGuardTimer = -1;
    BackgroundGuard.end();
    if (!this.loaded) {
      return;
    }
    const canLock = this.deviceCanLock();
    const s = this.state;
    const relock = !this.authenticating && !this.picking && s.settings.appLock && canLock && this.session.length > 0 &&
      this.backgroundSince > 0 && Date.now() - this.backgroundSince > LOCK_AFTER_MS;
    s.canLock = canLock;
    s.locked = s.locked || relock;
    this.connectIfLoggedIn();
    if (this.authed && this.peer === null && this.wantHwnd !== 0) {
      this.requestList();
    }
  }

  /**
   * 切到后台就停止看画面、断开和服务器的连接（鸿蒙不让 App 在后台常驻，审批提醒靠推送）。
   * 例外：选图、选文件、正在发文件时先撑着，有时限。
   */
  onBackground(): void {
    this.foreground = false;
    this.backgroundSince = Date.now();
    if (this.authenticating) {
      return;
    }
    if (this.picking || this.fileUploading()) {
      BackgroundGuard.begin(this.picking ? '选择要发给电脑的图片或文件' : '把文件发到电脑上');
      const start = Date.now();
      this.clearTimer(this.pickGuardTimer);
      this.pickGuardTimer = setInterval(() => {
        if (this.foreground) {
          this.clearTimer(this.pickGuardTimer);
          this.pickGuardTimer = -1;
          return;
        }
        const elapsed = Date.now() - start;
        const keep = this.fileUploading() ? elapsed <= UPLOAD_GRACE_MS : (this.picking && elapsed <= PICK_GRACE_MS);
        if (keep) {
          return;
        }
        this.clearTimer(this.pickGuardTimer);
        this.pickGuardTimer = -1;
        this.picking = false;
        this.stopStreaming(true);
        this.disconnect();
        BackgroundGuard.end();
      }, 1000);
      return;
    }
    this.stopStreaming(true);
    this.disconnect();
  }

  /** Wi-Fi 与移动网络之间切换后，旧连接多半已经不通，立即重连而不是等心跳超时 */
  onNetworkChanged(): void {
    if (!this.foreground || this.session.length === 0 || this.state.locked) {
      return;
    }
    Log.i('网络已切换，立即重连');
    this.backoffMs = INITIAL_BACKOFF_MS;
    // 旧连接作废（connect 会关掉它，不会再走 onSocketClosed），跟它有关的状态在这里清掉
    this.forgetConnection();
    this.openSocket();
  }

  /** 手机设置了锁屏密码（人脸、指纹也要先有密码），才能启用"打开时验证身份" */
  deviceCanLock(): boolean {
    const types: userAuth.UserAuthType[] = [userAuth.UserAuthType.PIN, userAuth.UserAuthType.FINGERPRINT,
      userAuth.UserAuthType.FACE];
    for (const t of types) {
      try {
        userAuth.getAvailableStatus(t, userAuth.AuthTrustLevel.ATL1);
        return true;
      } catch (e) {
        Log.i(`验证方式 ${t} 不可用：${errText(e as Object)}`);
      }
    }
    return false;
  }

  onUnlocked(): void {
    this.authenticating = false;
    this.state.locked = false;
    this.connectIfLoggedIn();
  }

  // ------------------------------------------------------------------ 账号：登录、注册、找回密码

  setAuthMode(mode: string): void {
    this.state.authMode = mode;
    this.state.authError = '';
    this.state.authInfo = '';
  }

  private resolveServer(serverInput: string): ServerAddressResult | null {
    const r = parseServerAddress(serverInput.trim(), ALLOW_CLEARTEXT);
    if (!r.ok) {
      this.state.authError = r.reason;
      this.state.authInfo = '';
      return null;
    }
    return r;
  }

  private device(): DeviceInfo {
    let name = (deviceInfo.marketName || deviceInfo.productModel || '').trim();
    if (name.length === 0) {
      name = '鸿蒙手机';
    }
    return { deviceId: this.deviceId, deviceName: name.substring(0, 64) };
  }

  login(serverInput: string, email: string, password: string): void {
    const server = this.resolveServer(serverInput);
    if (server === null) {
      return;
    }
    if (email.trim().length === 0 || password.length === 0) {
      this.state.authError = '请填写邮箱和密码';
      return;
    }
    this.runAuth(async () => {
      const r = await this.api.login(server.httpBase, email.trim(), password, this.device());
      if (r.ok) {
        this.signedIn(serverInput.trim(), server, r.token, r.email);
      } else {
        this.state.authError = r.message;
      }
    });
  }

  register(serverInput: string, email: string, code: string, password: string): void {
    const server = this.resolveServer(serverInput);
    if (server === null || !this.checkCodeForm(email, code, password)) {
      return;
    }
    this.runAuth(async () => {
      const r = await this.api.register(server.httpBase, email.trim(), code.trim(), password, this.device());
      if (r.ok) {
        this.signedIn(serverInput.trim(), server, r.token, r.email);
      } else {
        this.state.authError = r.message;
      }
    });
  }

  resetPassword(serverInput: string, email: string, code: string, password: string): void {
    const server = this.resolveServer(serverInput);
    if (server === null || !this.checkCodeForm(email, code, password)) {
      return;
    }
    this.runAuth(async () => {
      const r = await this.api.resetPassword(server.httpBase, email.trim(), code.trim(), password);
      if (r.ok) {
        this.state.authMode = AuthMode.Login;
        this.state.authError = '';
        this.state.authInfo = '密码已重置，请用新密码登录';
      } else {
        this.state.authError = r.message;
      }
    });
  }

  sendCode(serverInput: string, email: string): void {
    const server = this.resolveServer(serverInput);
    if (server === null) {
      return;
    }
    if (email.trim().length === 0) {
      this.state.authError = '请先填写邮箱';
      return;
    }
    const forgot = this.state.authMode === AuthMode.Forgot;
    this.state.codeSending = true;
    this.state.authError = '';
    this.state.authInfo = '';
    this.api.sendCode(server.httpBase, email.trim(), forgot ? 'reset' : 'register').then((r) => {
      const now = Date.now();
      this.state.codeSending = false;
      if (r.ok) {
        this.state.codeCooldownUntil = now + (r.cooldown > 0 ? r.cooldown : 60) * 1000;
        this.state.authInfo = forgot ? '如果这个邮箱注册过，验证码已经发出，请查收' : '验证码已发出，请查收邮件（也看看垃圾邮件）';
      } else {
        if (r.retryAfter > 0) {
          this.state.codeCooldownUntil = now + r.retryAfter * 1000;
        }
        this.state.authError = r.message;
      }
    });
  }

  private checkCodeForm(email: string, code: string, password: string): boolean {
    let error = '';
    if (email.trim().length === 0) {
      error = '请填写邮箱';
    } else if (!/^\d{6}$/.test(code.trim())) {
      error = '请填写邮件里的 6 位验证码';
    } else if (password.length < 8) {
      error = '密码至少 8 位';
    }
    if (error.length > 0) {
      this.state.authError = error;
      this.state.authInfo = '';
    }
    return error.length === 0;
  }

  private runAuth(block: () => Promise<void>): void {
    if (this.state.authBusy) {
      return;
    }
    this.state.authBusy = true;
    this.state.authError = '';
    this.state.authInfo = '';
    block().catch((e: Object) => {
      this.state.authError = `出错了：${errText(e)}`;
    }).finally(() => {
      this.state.authBusy = false;
    });
  }

  private signedIn(serverInput: string, server: ServerAddressResult, token: string, email: string): void {
    // 刚退出又马上登录：上次退出时延后的断开不要再执行
    this.clearTimer(this.logoutTimer);
    this.logoutTimer = -1;
    this.wsUrl = server.url;
    this.httpBase = server.httpBase;
    this.session = token;
    this.backoffMs = INITIAL_BACKOFF_MS;
    SettingsStore.saveServer(serverInput);
    SettingsStore.saveSession(token);
    SettingsStore.saveEmail(email);
    const s = this.state;
    s.serverInput = serverInput;
    s.email = email;
    s.authError = '';
    s.authInfo = '';
    s.hosts = [];
    s.windows = [];
    s.windowsLoaded = false;
    s.screen = Screens.Sessions;
    this.openSocket();
  }

  logout(): void {
    this.stopStreaming(true);
    // 先在还连着的信令上注销推送，免得退出后还收到这个账号的通知。没连着时靠下面删掉本机令牌
    // （服务器那边，这个登录作废时推送令牌也一起删，协议 2.10）
    if (this.pushToken.length > 0 && this.authed) {
      this.signaling.send(pushUnregisterMessage(this.pushToken));
    }
    // 马上算作没连上：还在取推送令牌的 registerPush 回来后就不会再登记
    this.authed = false;
    const token = this.session;
    const base = this.httpBase;
    this.pushToken = '';
    SettingsStore.savePushToken('');
    PushRegistrar.drop();
    // 稍等一下再断，让注销推送的消息发出去
    this.clearTimer(this.logoutTimer);
    this.logoutTimer = setTimeout(() => {
      this.logoutTimer = -1;
      this.disconnect();
    }, 300);
    this.approvalsByHost.clear();
    this.session = '';
    this.wantHwnd = 0;
    SettingsStore.saveSession('');
    SettingsStore.saveLastView('', 0);
    if (token.length > 0 && base.length > 0) {
      this.api.logout(base, token);
    }
    this.resetToAuth('');
  }

  /**
   * 设置里更换服务器：先退出旧服务器上的登录（通知旧服务器作废令牌、注销推送），再记下新地址，
   * 回到登录页用新服务器上的账号登录，登录后连新服务器。地址和现在的一样时什么都不做。
   * 返回不合法的原因；换好了（或没变）返回空串
   */
  changeServer(serverInput: string): string {
    const input = serverInput.trim();
    const server = parseServerAddress(input, ALLOW_CLEARTEXT);
    if (!server.ok) {
      return server.reason;
    }
    if (server.url === this.wsUrl) {
      return '';
    }
    this.logout();
    this.wsUrl = server.url;
    this.httpBase = server.httpBase;
    SettingsStore.saveServer(input);
    this.state.serverInput = input;
    this.state.authError = '';
    this.state.authInfo = `已换到 ${input}，请用这个服务器上的账号登录`;
    return '';
  }

  /** 令牌被服务器拒绝（在别处退出、重置了密码、过期）：清掉登录状态，回到登录页 */
  private signedOutByServer(message: string): void {
    this.forgetHostStates();
    this.stopStreaming(false);
    this.session = '';
    this.approvalsByHost.clear();
    SettingsStore.saveSession('');
    this.resetToAuth(message);
  }

  private resetToAuth(error: string): void {
    const s = this.state;
    s.screen = Screens.Auth;
    s.authMode = AuthMode.Login;
    s.authBusy = false;
    s.authError = error;
    s.authInfo = '';
    s.link = Link.Offline;
    s.hosts = [];
    s.windows = [];
    s.windowsLoaded = false;
    s.current = null;
    s.catalog = [];
    s.catalogPhase = CatalogPhase.None;
    s.opening = null;
    s.closingWindows = [];
    s.hostUpdate = null;
    s.approvals = [];
    s.showApprovals = false;
    s.answering = [];
    s.locked = false;
    s.applyHostState(null);
  }

  // ------------------------------------------------------------------ 信令连接

  private connectIfLoggedIn(): void {
    if (!this.foreground || this.state.locked) {
      return;
    }
    if (Date.now() < this.reconnectNotBefore) {
      return; // 服务器暂时锁了，等定好的重连
    }
    if (this.session.length > 0 && this.wsUrl.length > 0 && !this.signaling.isActive) {
      this.openSocket();
    }
  }

  private openSocket(): void {
    if (this.wsUrl.length === 0) {
      return;
    }
    this.clearTimer(this.retryTimer);
    this.retryTimer = -1;
    this.authed = false;
    this.state.link = Link.Connecting;
    this.signaling.connect(this.wsUrl);
  }

  private disconnect(): void {
    this.clearTimer(this.retryTimer);
    this.retryTimer = -1;
    this.clearTimer(this.refreshTimer);
    this.signaling.close();
    this.authed = false;
    this.forgetHostStates();
    this.state.link = Link.Offline;
    this.state.refreshing = false;
    this.state.applyHostState(null);
  }

  /** 和服务器的连接断了：电脑的状态不再可信（重连后电脑会重新推），等着的解锁回执也等不到了 */
  private forgetHostStates(): void {
    this.hostStates.clear();
    this.hostCmdWaiters.forEach((w: Waiter<string>) => w.complete('closed'));
  }

  private sendAuth(): void {
    if (this.session.length === 0) {
      this.signaling.close();
    } else {
      this.signaling.send(authMessage(this.session, CLIENT_NAME));
    }
  }

  private onSocketClosed(): void {
    this.forgetConnection();
    const retry = this.foreground && this.session.length > 0;
    this.state.link = retry ? Link.Connecting : Link.Offline;
    this.state.refreshing = false;
    this.state.catalogRefreshing = false;
    if (retry) {
      this.scheduleReconnect();
    }
  }

  /** 信令连接没了：画面、等着的打开会话和关窗口、电脑状态、解锁回执都跟着作废（重连后电脑会重新推） */
  private forgetConnection(): void {
    this.authed = false;
    this.forgetHostStates();
    this.stopStreaming(false);
    if (this.state.opening !== null) {
      this.cancelOpening();
      this.toast('和服务器的连接断开了，不知道会话打开了没有，重连后看看');
    }
    this.forgetCloseRequests();
  }

  private scheduleReconnect(): void {
    this.clearTimer(this.retryTimer);
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = -1;
      this.reconnectNotBefore = 0;
      if (this.foreground && this.session.length > 0) {
        this.openSocket();
      }
    }, wait);
  }

  private handle(msg: Incoming): void {
    const hostId = this.state.hostId;
    // 电脑回了窗口列表，却一直没推过状态：是不认 host-cmd 的旧版被控端（协议 2.9）
    if (msg.type === 'windows' && msg.host === hostId && !this.hostStates.has(msg.host) && !this.state.hostTooOld) {
      this.state.hostTooOld = true;
    }
    switch (msg.type) {
      case 'auth-ok':
        this.onAuthOk(msg.email, msg.iceServers, msg.hosts);
        break;
      case 'auth-fail':
        this.onAuthFail(msg.reason);
        break;
      case 'hosts':
        this.onHosts(msg.hosts);
        break;
      case 'windows':
        if (msg.host === hostId) {
          this.onWindows(msg.list, msg.thumbs);
        }
        break;
      case 'offer':
        if (msg.host === hostId) {
          this.onOffer(msg.host, msg.sdp, msg.hwnd, msg.title);
        }
        break;
      case 'ice':
        if (msg.host === this.peerHost) {
          this.peer?.addRemoteIce(msg.candidate);
        }
        break;
      case 'selected':
        if (msg.host === hostId) {
          this.state.current = { hwnd: msg.hwnd, title: msg.title };
        }
        break;
      case 'window-closed':
        if (msg.host === hostId) {
          this.toast('该窗口已关闭');
          this.leaveRemote();
        }
        break;
      case 'sessions':
        if (msg.host === hostId) {
          this.clearTimer(this.catalogTimer);
          this.state.catalog = msg.groups;
          this.state.catalogPhase = msg.available ? CatalogPhase.Loaded : CatalogPhase.Unavailable;
          this.state.catalogRefreshing = false;
        }
        break;
      case 'session-opened':
        if (msg.host === hostId) {
          this.onSessionOpened(msg.req, msg.hwnd, msg.title, msg.envOk);
        }
        break;
      case 'session-failed':
        if (msg.host === hostId) {
          this.onSessionFailed(msg.req, msg.code);
        }
        break;
      case 'close-window-result':
        if (msg.host === hostId) {
          this.onCloseResult(msg.req, msg.ok, msg.code);
        }
        break;
      case 'host-update-state':
        if (msg.host === hostId) {
          this.state.hostUpdate = msg.state;
        }
        break;
      case 'approvals':
        this.approvalsByHost.set(msg.host, msg.list);
        this.publishApprovals();
        break;
      case 'approval-result':
        this.onApprovalResult(msg.id, msg.ok, msg.code);
        break;
      case 'host-state':
        this.hostStates.set(msg.host, msg.state);
        if (msg.host === hostId) {
          this.state.applyHostState(msg.state);
        }
        break;
      case 'host-cmd-result':
        if (msg.host === hostId) {
          this.hostCmdWaiters.get(msg.req)?.complete(msg.ok ? HostCommands.OK : msg.code);
        }
        break;
      case 'push-register-result':
        if (msg.ok) {
          Log.i('服务器收下了推送令牌');
        } else {
          Log.w(`服务器没收下推送令牌：${msg.code}`);
        }
        break;
      case 'error':
        if (msg.host === hostId) {
          this.toast(this.errorText(msg.code));
          if (msg.code === 'capture-failed') {
            this.leaveRemote();
          } else if (msg.code === 'host-offline') {
            this.stopStreaming(false);
          }
        }
        break;
      default:
        break;
    }
  }

  private onAuthOk(email: string, iceServers: IceServerSpec[], hosts: HostInfo[]): void {
    this.authed = true;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.iceServers = iceServers;
    if (email.length > 0 && email !== this.state.email) {
      SettingsStore.saveEmail(email);
      this.state.email = email;
    }
    this.state.link = Link.Online;
    this.state.hosts = hosts;
    this.chooseHost();
    this.requestList();
    if (this.state.listTab === ListTab.All) {
      this.refreshCatalog();
    }
    this.registerPush();
  }

  /** 每次连上都登记一次推送令牌（令牌可能变，服务器按令牌去重） */
  private async registerPush(): Promise<void> {
    const token = await PushRegistrar.token();
    // 取令牌是异步的，这期间可能已经退出登录或断线了
    if (token.length === 0 || !this.authed || this.session.length === 0) {
      return;
    }
    await PushRegistrar.ensureNotifications();
    if (!this.authed || this.session.length === 0) {
      return;
    }
    if (this.signaling.send(pushRegisterMessage(token))) {
      this.pushToken = token;
      SettingsStore.savePushToken(token);
    }
  }

  private onAuthFail(reason: string): void {
    this.signaling.close(); // 服务器随后会断开，这里先关掉，免得触发普通的断线重连
    this.authed = false;
    switch (reason) {
      case 'locked':
        this.toast('连接失败次数太多，稍后自动重试');
        this.state.link = Link.Connecting;
        this.backoffMs = 60000;
        this.reconnectNotBefore = Date.now() + 60000;
        this.scheduleReconnect();
        break;
      case 'bad-proto':
        this.signedOutByServer('App 版本太旧，和服务器不兼容，请更新');
        break;
      case 'revoked':
        this.signedOutByServer('账号已在别处退出登录或修改了密码，请重新登录');
        break;
      default:
        this.signedOutByServer('登录已过期，请重新登录');
        break;
    }
  }

  private onHosts(hosts: HostInfo[]): void {
    const wasOnline = this.state.hostOnline();
    this.state.hosts = hosts;
    // 下线了的电脑，它的审批也结束了
    const online = new Set<string>(hosts.filter((h: HostInfo) => h.online).map((h: HostInfo) => h.id));
    let changed = false;
    Array.from(this.approvalsByHost.keys()).forEach((h: string) => {
      if (!online.has(h)) {
        this.approvalsByHost.delete(h);
        changed = true;
      }
    });
    if (changed) {
      this.publishApprovals();
    }
    Array.from(this.hostStates.keys()).forEach((h: string) => {
      if (!online.has(h)) {
        this.hostStates.delete(h);
      }
    });
    const hostId = this.state.hostId;
    if (hostId.length > 0 && !hosts.some((h: HostInfo) => h.id === hostId)) {
      this.setHost('');
    }
    this.chooseHost();
    const nowOnline = this.state.hostOnline();
    if (wasOnline && !nowOnline) {
      this.stopStreaming(false);
    }
    if (!nowOnline) {
      this.state.applyHostState(null);
    }
    if (nowOnline && (!wasOnline || this.state.windows.length === 0)) {
      this.requestList();
      if (this.state.listTab === ListTab.All) {
        this.refreshCatalog();
      }
    }
  }

  /** 选电脑：记住的那台还在就用它；否则只有一台（在线）时自动选上 */
  private chooseHost(): void {
    const hosts = this.state.hosts;
    const hostId = this.state.hostId;
    if (hostId.length > 0 && hosts.some((h: HostInfo) => h.id === hostId)) {
      return;
    }
    const online = hosts.filter((h: HostInfo) => h.online);
    let pick = '';
    if (online.length === 1) {
      pick = online[0].id;
    } else if (hosts.length === 1) {
      pick = hosts[0].id;
    }
    this.setHost(pick);
  }

  /** 用户在会话列表上方点选另一台电脑 */
  selectHost(id: string): void {
    if (id === this.state.hostId) {
      return;
    }
    this.setHost(id);
    this.requestList();
    if (this.state.listTab === ListTab.All) {
      this.refreshCatalog();
    }
  }

  private setHost(id: string): void {
    if (id === this.state.hostId) {
      return;
    }
    this.stopStreaming(true);
    this.wantHwnd = 0;
    SettingsStore.saveLastView(id, 0);
    if (this.state.opening !== null) {
      this.cancelOpening();
    }
    this.forgetCloseRequests();
    const s = this.state;
    s.hostId = id;
    s.windows = [];
    s.windowsLoaded = false;
    s.current = null;
    s.catalog = [];
    s.catalogPhase = CatalogPhase.None;
    s.hostUpdate = null;
    s.applyHostState(id.length > 0 ? (this.hostStates.get(id) ?? null) : null);
  }

  refreshWindows(): void {
    this.requestList();
  }

  private requestList(): void {
    const host = this.state.hostId;
    if (!this.authed || host.length === 0 || !this.state.hostOnline()) {
      return;
    }
    this.signaling.send(listMessage(host));
    this.state.refreshing = true;
    this.clearTimer(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.state.refreshing = false;
    }, REFRESH_TIMEOUT_MS);
  }

  /**
   * 电脑发来窗口列表。被控端 0.9.7 起分两次回（协议 2.4）：先是不带缩略图的一份（THUMBS_PENDING），
   * 标题、个数先对上，图沿用手上的；随后一份带图的（THUMBS_DONE）。旧版被控端只回一份带图的，thumbs 为 null
   */
  private onWindows(list: RemoteWindow[], thumbs: string | null): void {
    const old = new Map<number, string | null>();
    this.state.windows.forEach((w: WindowItem) => old.set(w.hwnd, w.thumb));
    const pending = thumbs === THUMBS_PENDING;
    const items: WindowItem[] = list.map((w: RemoteWindow): WindowItem => {
      const item: WindowItem = {
        hwnd: w.hwnd,
        title: w.title,
        minimized: w.minimized,
        thumb: pending ? (old.get(w.hwnd) ?? null) : w.thumb,
        closable: w.closable,
        thumbLoading: pending
      };
      return item;
    });
    this.clearTimer(this.refreshTimer);
    this.state.windows = items;
    this.state.windowsLoaded = true;
    this.state.refreshing = false;
    if (thumbs === THUMBS_DONE) {
      return; // 补缩略图的那一份：下面的事前一份已经办过了
    }
    // 还没有画面时，自动回到想看的那个窗口（断线重连、回到前台、冷启动）
    if (this.peer !== null || this.wantHwnd === 0) {
      return;
    }
    const target = items.find((w: WindowItem) => w.hwnd === this.wantHwnd);
    if (target !== undefined) {
      this.select(target.hwnd, target.title);
    } else if (this.state.screen === Screens.Remote) {
      this.toast('刚才查看的窗口已经不在了');
      this.leaveRemote();
    } else {
      this.forgetWindow();
    }
  }

  // ------------------------------------------------------------------ 浏览、打开、新建 Claude 会话（协议 2.5）

  setListTab(tab: string): void {
    if (tab === this.state.listTab) {
      return;
    }
    this.state.listTab = tab;
    if (tab === ListTab.All) {
      this.refreshCatalog();
    } else {
      this.requestList();
    }
  }

  refreshCatalog(): void {
    const host = this.state.hostId;
    if (!this.authed || host.length === 0 || !this.state.hostOnline()) {
      return;
    }
    this.signaling.send(listSessionsMessage(host));
    this.state.catalogRefreshing = true;
    this.clearTimer(this.catalogTimer);
    this.catalogTimer = setTimeout(() => {
      // 旧版被控端不认这个请求，不会回话
      this.state.catalogRefreshing = false;
      if (this.state.catalogPhase === CatalogPhase.None) {
        this.state.catalogPhase = CatalogPhase.NoReply;
      }
    }, REFRESH_TIMEOUT_MS);
  }

  /** 打开一个会话：电脑上已经开着就直接看，没开就先在电脑上开成单独窗口 */
  openSession(entry: SessionEntry): void {
    const name = entry.title.length > 0 ? entry.title : '会话';
    this.startOpening(entry.open ? `正在切到「${name}」…` : `正在电脑上打开「${name}」…`,
      (host: string, req: string) => openSessionMessage(host, entry.id, req));
  }

  /** 在这个环境下新建会话：电脑上开一个新的会话窗口并选好环境 */
  newSession(group: SessionGroup): void {
    const env = group.env;
    if (env === null) {
      return;
    }
    this.startOpening(`正在电脑上新建会话（${group.name}）…`, (host: string, req: string) => newSessionMessage(host, env, req));
  }

  private startOpening(label: string, build: (host: string, req: string) => string): void {
    if (this.state.opening !== null) {
      return;
    }
    const host = this.state.hostId;
    if (!this.authed || host.length === 0 || !this.state.hostOnline()) {
      this.toast('这台电脑不在线');
      return;
    }
    this.openSeq++;
    const req = `s${this.openSeq}`;
    this.signaling.send(build(host, req));
    this.state.opening = { req: req, label: label };
    this.clearTimer(this.openTimer);
    this.openTimer = setTimeout(() => {
      if (this.state.opening?.req === req) {
        this.state.opening = null;
        this.toast('电脑没有回应（被控端可能是旧版本），没能打开');
      }
    }, OPEN_TIMEOUT_MS);
  }

  /** 不等了。电脑那边可能还是会把窗口开出来，但回话来了也不再跳过去 */
  cancelOpening(): void {
    this.clearTimer(this.openTimer);
    this.state.opening = null;
  }

  private onSessionOpened(req: string, hwnd: number, title: string, envOk: boolean): void {
    if (this.state.opening?.req !== req) {
      return;
    }
    this.clearTimer(this.openTimer);
    this.state.opening = null;
    if (!envOk) {
      this.toast('没能自动选上环境，请在画面里手动选');
    }
    this.select(hwnd, title);
  }

  private onSessionFailed(req: string, code: string): void {
    if (this.state.opening?.req !== req) {
      return;
    }
    this.clearTimer(this.openTimer);
    this.state.opening = null;
    this.toast(this.sessionErrorText(code));
  }

  private sessionErrorText(code: string): string {
    switch (code) {
      case 'busy':
        return '电脑正在打开另一个会话，稍等再试';
      case 'locked':
        return '电脑锁屏了，解锁后再试';
      case 'not-found':
        return '电脑上找不到这个会话了，下拉刷新一下';
      case 'no-title':
        return '这个会话还没有标题，没法自动打开，请在电脑上操作';
      case 'no-claude':
        return '电脑上没找到 Claude 桌面端';
      case 'no-main':
        return 'Claude 主窗口没有出来，请确认 Claude 在运行';
      case 'ui-missing':
        return '没在 Claude 界面里找到要点的菜单（可能 Claude 升级了），请在电脑上操作';
      case 'no-window':
        return '电脑上没等到新窗口出来，请在电脑上看看';
      case 'timeout':
        return '电脑上的操作超时了';
      case 'stuck':
        return 'Claude 给的会话窗口卡住了，没能显示这个会话，请在电脑上重启 Claude';
      default:
        return `没能打开（${code}）`;
    }
  }

  // ------------------------------------------------------------------ 关闭会话窗口（协议 2.8）

  /** 关掉电脑上的一个会话窗口，不用确认：会话不删，"全部会话"里能再打开 */
  closeWindow(item: WindowItem): void {
    const host = this.state.hostId;
    if (host.length === 0) {
      return;
    }
    if (!this.authed || !this.state.hostOnline()) {
      this.toast('这台电脑不在线');
      return;
    }
    if (item.closable === null) {
      this.state.closeUnsupported = true;
      return;
    }
    if (!item.closable || this.state.closingWindows.includes(item.hwnd)) {
      return;
    }
    this.closeSeq++;
    const req = `c${this.closeSeq}`;
    this.closeRequests.set(req, item);
    this.signaling.send(closeWindowMessage(host, item.hwnd, item.title, req));
    this.state.closingWindows = this.state.closingWindows.concat([item.hwnd]);
    setTimeout(() => {
      if (this.closeRequests.delete(req)) {
        this.state.closingWindows = this.state.closingWindows.filter((h: number) => h !== item.hwnd);
        this.toast(`电脑没有回应，没能关掉「${item.title}」`);
        this.requestList();
      }
    }, WindowClose.TIMEOUT_MS);
  }

  dismissCloseUnsupported(): void {
    this.state.closeUnsupported = false;
  }

  private onCloseResult(req: string, ok: boolean, code: string): void {
    const item = this.closeRequests.get(req);
    if (item === undefined) {
      return;
    }
    this.closeRequests.delete(req);
    this.state.closingWindows = this.state.closingWindows.filter((h: number) => h !== item.hwnd);
    if (WindowClose.removesCard(ok, code)) {
      this.state.windows = this.state.windows.filter((w: WindowItem) => w.hwnd !== item.hwnd);
      // 这个句柄以后可能被 Claude 拿去开别的会话，别再自动选回它
      if (this.wantHwnd === item.hwnd) {
        this.forgetWindow();
      }
      if (this.state.current?.hwnd === item.hwnd) {
        this.stopStreaming(true);
        this.state.current = null;
        this.state.screen = Screens.Sessions;
      }
    }
    this.toast(WindowClose.resultText(ok, code, item.title));
  }

  private forgetCloseRequests(): void {
    this.closeRequests.clear();
    if (this.state.closingWindows.length > 0) {
      this.state.closingWindows = [];
    }
  }

  // ------------------------------------------------------------------ 审批（docs/09）

  private publishApprovals(): void {
    const hosts = this.state.hosts;
    const list: PendingApproval[] = [];
    this.approvalsByHost.forEach((items: Approval[], h: string) => {
      const host = hosts.find((x: HostInfo) => x.id === h);
      const name = host !== undefined ? host.name : '电脑';
      items.forEach((a: Approval) => list.push({ hostId: h, hostName: name, item: a }));
    });
    list.sort((a: PendingApproval, b: PendingApproval) => a.item.createdAt - b.item.createdAt);
    const ids = new Set<string>(list.map((p: PendingApproval) => p.item.id));
    this.state.approvals = list;
    this.state.answering = this.state.answering.filter((id: string) => ids.has(id));
    this.state.showApprovals = (this.state.showApprovals || this.approvalsRequested) && list.length > 0;
    if (this.approvalsRequested && list.length > 0) {
      this.approvalsRequested = false;
    }
  }

  openApprovals(): void {
    this.state.showApprovals = this.state.approvals.length > 0;
  }

  /** 点推送通知打开 App 时：审批列表可能还没从电脑推过来（刚连上），到了就自动打开面板，最多等 15 秒 */
  openApprovalsWhenReady(): void {
    if (this.state.approvals.length > 0) {
      this.openApprovals();
      return;
    }
    this.approvalsRequested = true;
    this.clearTimer(this.approvalsWaitTimer);
    this.approvalsWaitTimer = setTimeout(() => {
      this.approvalsWaitTimer = -1;
      this.approvalsRequested = false;
    }, 15000);
  }

  closeApprovals(): void {
    this.state.showApprovals = false;
  }

  /**
   * 回答一条审批：choice 是 allow 或 deny，拒绝时 text 是说明；回答提问时 answers 是
   * 问题原文 -> 选项或自己填的文字（多选给列表）。没连上服务器时返回 false。
   */
  answerApproval(hostId: string, id: string, choice: string, text: string,
    answers: Record<string, string | string[]> | null): boolean {
    if (!this.authed) {
      return false;
    }
    this.approvalSeq++;
    const req = `a${this.approvalSeq}`;
    if (!this.signaling.send(approvalAnswerMessage(hostId, id, req, choice, text, answers))) {
      return false;
    }
    this.state.answering = this.state.answering.concat([id]);
    return true;
  }

  private onApprovalResult(id: string, ok: boolean, code: string): void {
    this.state.answering = this.state.answering.filter((x: string) => x !== id);
    if (ok) {
      return;
    }
    if (code === 'gone') {
      this.toast('这个审批已经在别处答了或已经结束');
    } else if (code === 'bad') {
      this.toast('答案不完整，请每个问题都选一下');
    } else {
      this.toast(`没能提交（${code}）`);
    }
  }

  // ------------------------------------------------------------------ 电脑被控端升级（协议 2.6）

  hostUpdate(op: string): void {
    const host = this.state.hostId;
    if (host.length === 0 || !this.authed || !this.state.hostOnline()) {
      return;
    }
    this.signaling.send(hostUpdateMessage(host, op));
    if (op === 'install') {
      this.toast('电脑上的被控端会重启升级，稍后自动重连');
    } else if (op === 'check') {
      this.toast('已让电脑检查更新');
    }
  }

  // ------------------------------------------------------------------ 选择窗口与画面连接

  select(hwnd: number, title: string): void {
    const host = this.state.hostId;
    if (host.length === 0) {
      return;
    }
    this.wantHwnd = hwnd;
    SettingsStore.saveLastView(host, hwnd);
    this.state.current = { hwnd: hwnd, title: title };
    this.state.screen = Screens.Remote;
    if (this.peer === null) {
      this.state.rtc = RtcPhase.Connecting;
    }
    // 已有画面连接时，电脑直接换画面，回 selected；否则新建连接，回 offer
    if (this.authed) {
      this.signaling.send(selectMessage(host, hwnd));
    }
  }

  /** 画面页上点了返回：正在发文件时离开会断开连接、文件就发不完了，先问一下 */
  backFromRemote(): void {
    const u = this.state.upload;
    if (u !== null && u.fileName !== null && !u.pasting) {
      this.state.leaveConfirm = true;
    } else {
      this.leaveRemote();
    }
  }

  /** 从画面页返回会话列表：停止看画面，之后不再自动选回这个窗口 */
  leaveRemote(): void {
    this.stopStreaming(true);
    this.forgetWindow();
    this.state.current = null;
    this.state.screen = Screens.Sessions;
    this.requestList();
    // 刚才可能打开了新的会话窗口，全部会话里的"已打开"标记要跟着变
    if (this.state.listTab === ListTab.All) {
      this.refreshCatalog();
    }
  }

  private forgetWindow(): void {
    this.wantHwnd = 0;
    SettingsStore.saveLastView(this.state.hostId, 0);
  }

  private onOffer(host: string, sdp: string, hwnd: number, title: string): void {
    // 电脑发来新的 offer 时，它那边的旧连接已经关了
    this.stopStreaming(false);
    let session: PeerSession;
    try {
      session = new PeerSession(this.iceServers, {
        onLocalIce: (c: IceCandidateSpec) => {
          if (this.peer === session && this.peerHost.length > 0) {
            this.signaling.send(iceMessage(this.peerHost, c));
          }
        },
        onVideoTrack: (track: webrtc.MediaStreamTrack) => {
          if (this.peer !== session) {
            return;
          }
          this.videoTrack = track;
          this.renderer?.setVideoTrack(track);
        },
        onConnectionState: (state: string) => this.onConnectionState(session, state),
        onInputOpen: () => {
        },
        onInputError: (code: string, detail: string | null) => {
          if (this.peer === session) {
            this.toast(withDetail(this.errorText(code), detail));
          }
        },
        onImageReply: (reply: ImageReply) => {
          if (this.peer === session) {
            this.imageWaiters.get(reply.id)?.complete(reply.code ?? IMAGE_OK);
          }
        },
        onLockState: (st: LockState) => {
          if (this.peer === session) {
            this.state.pcLocked = st.locked;
            this.state.unlockAvailable = st.unlockAvailable;
            this.state.unlockUntrusted = st.unlockUntrusted;
          }
        },
        onUnlockResult: (r: UnlockResult) => {
          if (this.peer === session) {
            this.unlockWaiters.get(r.id)?.complete(r.code ?? IMAGE_OK);
          }
        },
        onTileState: (st: TileState) => {
          if (this.peer === session) {
            this.state.tileAvailable = st.available;
            this.state.tilePaused = st.paused;
          }
        },
        onFileCaps: (max: number) => {
          if (this.peer === session) {
            this.state.fileMax = max;
          }
        },
        onFileReply: (reply: FileReply) => {
          if (this.peer === session) {
            this.fileWaiters.get(reply.id)?.complete(reply);
          }
        },
        onClipboardText: (text: string) => {
          if (this.peer === session) {
            this.receiveClipboard(text);
          }
        },
        onClipboardSkipped: (code: string) => {
          if (this.peer === session && this.state.settings.syncClipboard && code === 'too-large') {
            this.toast('电脑上复制的文字太长，没有同步到手机');
          }
        }
      });
    } catch (e) {
      Log.e(`创建画面连接失败：${errText(e as Object)}`);
      this.toast('创建画面连接失败');
      return;
    }
    this.peer = session;
    this.peerHost = host;
    this.statsCursor = new StatsCursor();
    this.state.current = { hwnd: hwnd, title: title };
    this.state.rtc = RtcPhase.Connecting;
    this.state.hasVideo = false;
    session.acceptOffer(sdp).then((answer: string) => {
      if (this.peer === session) {
        this.signaling.send(answerMessage(host, answer));
      }
    }).catch((e: Object) => {
      Log.e(`建立画面连接失败：${errText(e)}`);
      if (this.peer === session) {
        this.toast('建立画面连接失败');
        this.state.rtc = RtcPhase.Failed;
      }
    });
    this.startStats();
  }

  private onConnectionState(session: PeerSession, state: string): void {
    if (this.peer !== session) {
      return;
    }
    this.state.rtc = state === 'connected' ? RtcPhase.Connected : (state === 'failed' ? RtcPhase.Failed : RtcPhase.Connecting);
    this.clearTimer(this.reselectTimer);
    if (state === 'failed') {
      this.scheduleReselect(300);
    } else if (state === 'disconnected') {
      this.scheduleReselect(DISCONNECTED_GRACE_MS);
    }
  }

  /**
   * 电脑上新复制的文字（协议 4.9）：放进手机剪贴板，每次都提示一下。
   */
  private receiveClipboard(text: string): void {
    if (!this.state.settings.syncClipboard || text.length === 0) {
      return;
    }
    try {
      const data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, text);
      pasteboard.getSystemPasteboard().setDataSync(data);
      this.toast('已复制电脑上的文字');
    } catch (e) {
      Log.w(`写手机剪贴板失败：${errText(e as Object)}`);
      this.toast('电脑上复制的文字没能放进手机剪贴板');
    }
  }

  /**
   * 画面连接断了且自己恢复不了：关掉两边的旧连接，重新向电脑要一次画面。
   * 先发 stop 让电脑也关掉旧连接，否则它可能以为连接还在，只换画面不重新协商。
   */
  private scheduleReselect(delayMs: number): void {
    this.reselectTimer = setTimeout(() => {
      this.reselectTimer = -1;
      const cur = this.state.current;
      const host = this.state.hostId;
      const p = this.peer;
      if (cur === null || host.length === 0 || p === null || p.connectionState === 'connected') {
        return;
      }
      if (!this.authed || !this.state.hostOnline()) {
        return;
      }
      Log.i('画面连接已断开，重新请求');
      this.stopStreaming(true);
      this.state.rtc = RtcPhase.Connecting;
      this.signaling.send(selectMessage(host, cur.hwnd));
    }, delayMs);
  }

  /** 关掉画面连接，但保留"想看哪个窗口"，以便之后自动恢复 */
  private stopStreaming(sendStop: boolean): void {
    this.clearTimer(this.reselectTimer);
    this.reselectTimer = -1;
    this.clearTimer(this.statsTimer);
    this.statsTimer = -1;
    this.state.stats = null;
    this.input.reset();
    const p = this.peer;
    if (p === null) {
      this.state.rtc = RtcPhase.None;
      this.state.hasVideo = false;
      this.state.applyHostState(this.hostStates.get(this.state.hostId) ?? null);
      return;
    }
    if (sendStop && this.authed && this.peerHost.length > 0) {
      this.signaling.send(stopMessage(this.peerHost));
    }
    // 先把渲染器从轨道上摘下来，轨道会随连接一起释放
    this.renderer?.setVideoTrack(null);
    this.videoTrack = null;
    this.peer = null;
    this.peerHost = '';
    this.imageWaiters.forEach((w: Waiter<string>) => w.complete('closed'));
    this.unlockWaiters.forEach((w: Waiter<string>) => w.complete('closed'));
    this.fileWaiters.forEach((w: Waiter<FileReply>, id: string) => {
      w.complete({ id: id, path: null, name: null, pasted: false, code: 'closed' });
    });
    p.close();
    this.state.rtc = RtcPhase.None;
    this.state.hasVideo = false;
    this.state.fileMax = 0;
    // 锁屏、平铺状态：新版被控端经信令通道也推（协议 2.9），没有画面也知道；旧版的就不知道了
    this.state.applyHostState(this.hostStates.get(this.state.hostId) ?? null);
  }

  // ------------------------------------------------------------------ 画面显示与输入

  attachRenderer(r: VideoRenderController): void {
    this.renderer = r;
    r.setVideoTrack(this.videoTrack);
  }

  detachRenderer(r: VideoRenderController): void {
    if (this.renderer !== r) {
      return;
    }
    r.setVideoTrack(null);
    this.renderer = null;
  }

  /** 渲染器报了画面分辨率（新轨道的第一帧也会报一次） */
  onVideoSize(width: number, height: number): void {
    this.state.videoWidth = width;
    this.state.videoHeight = height;
    if (this.peer !== null && this.videoTrack !== null) {
      this.state.hasVideo = true;
    }
  }

  tap(p: RemotePoint): void {
    if (!this.input.click(p, BUTTON_LEFT)) {
      this.toast(NOT_READY);
    }
  }

  longPress(p: RemotePoint): void {
    if (!this.input.click(p, BUTTON_RIGHT)) {
      this.toast(NOT_READY);
    }
  }

  scroll(p: RemotePoint, dx: number, dy: number): void {
    this.input.wheel(p, dx, dy);
  }

  sendKey(key: string, mods: number): void {
    if (!this.input.key(key, mods)) {
      this.toast(NOT_READY);
    }
  }

  /** 调电脑上 Claude 的字体大小：给正在看的窗口按 Claude 的缩放快捷键，见 FontZoom */
  fontZoom(step: FontZoom): void {
    this.sendKey(step.key, step.mods);
  }

  /** 发送文字，pressEnter 为真时再按一次回车。返回是否已发出（发出后调用方清空输入框） */
  sendText(text: string, pressEnter: boolean): boolean {
    if (this.peer === null || !this.peer.inputOpen) {
      this.toast(NOT_READY);
      return false;
    }
    // 文件走单独的通道，文字不会排在它后面：留在输入框里，等路径粘贴好再发
    if (this.fileUploading()) {
      this.toast('文件还在发送，等路径粘贴好再发文字');
      return false;
    }
    if (text.length > 0) {
      // 日志只记字数和行数，不记内容
      Log.i(`发送文字：${text.length} 个字符，${text.split('\n').length} 行`);
      this.input.text(text);
    }
    if (pressEnter) {
      this.input.key('Enter', 0);
    }
    return true;
  }

  // ------------------------------------------------------------------ 发图片（协议 4.5）

  /** 打开系统选图或选文件界面之前调用 */
  beginPick(): void {
    this.picking = true;
  }

  /** 选图界面返回后调用；uri 为空串表示取消了 */
  endPickImage(uri: string): void {
    this.picking = false;
    if (uri.length > 0) {
      this.sendImage(uri);
    }
  }

  private async sendImage(uri: string): Promise<void> {
    if (this.uploading) {
      this.toast(this.uploadIsFile ? '文件还在发送' : '上一张图片还在发送');
      return;
    }
    if (this.peer === null || !this.peer.inputOpen) {
      this.toast(NOT_READY);
      return;
    }
    this.uploading = true;
    this.uploadIsFile = false;
    this.state.upload = { sent: 0, total: 0, preparing: true, pasting: false, fileName: null };
    try {
      let img: PreparedImage;
      try {
        img = await ImagePrep.prepare(uri);
      } catch (e) {
        Log.w(`读取图片失败：${errText(e as Object)}`);
        this.toast('读取图片失败');
        return;
      }
      if (img.bytes.byteLength > IMAGE_MAX_BYTES) {
        this.toast('图片太大了');
        return;
      }
      Log.i(`发送图片 ${img.width}x${img.height} ${img.mime} ${Math.round(img.bytes.byteLength / 1024)} KB`);
      this.toast(await this.transferImage(img.bytes, img.mime));
    } finally {
      this.uploading = false;
      this.state.upload = null;
    }
  }

  /** 分块发出图片并等电脑的回执，返回给用户看的结果 */
  private async transferImage(bytes: ArrayBuffer, mime: string): Promise<string> {
    const s = this.peer;
    if (s === null || !s.inputOpen) {
      return NOT_READY;
    }
    const id = shortId('');
    const waiter = new Waiter<string>();
    this.imageWaiters.set(id, waiter);
    try {
      if (!s.sendInput(imageBeginEvent(id, mime, bytes.byteLength))) {
        return NOT_READY;
      }
      let offset = 0;
      const total = bytes.byteLength;
      while (offset < total) {
        if (this.peer !== s || !s.inputOpen) {
          return this.errorText('closed');
        }
        // 排队的数据太多就等一等，既不撑爆通道的缓冲，进度条也更接近实际
        if (s.bufferedAmount() > MAX_BUFFERED) {
          await delay(10);
          continue;
        }
        const n = Math.min(IMAGE_CHUNK, total - offset);
        if (!s.sendBinary(bytes.slice(offset, offset + n))) {
          return this.errorText('closed');
        }
        offset += n;
        this.state.upload = { sent: offset, total: total, preparing: false, pasting: false, fileName: null };
      }
      if (!s.sendInput(imageEndEvent(id))) {
        return this.errorText('closed');
      }
      this.state.upload = { sent: total, total: total, preparing: false, pasting: true, fileName: null };
      const code = await withTimeout(waiter.promise, IMAGE_REPLY_TIMEOUT_MS);
      if (code === null) {
        return '电脑没有回应，电脑上的被控端可能需要更新';
      }
      return code === IMAGE_OK ? '图片已粘贴到输入框' : this.errorText(code);
    } finally {
      this.imageWaiters.delete(id);
    }
  }

  // ------------------------------------------------------------------ 发文件（协议 4.8）

  /** 正在发文件，还没等到电脑的回执 */
  private fileUploading(): boolean {
    return this.uploading && this.uploadIsFile;
  }

  /** 选文件之前检查：电脑上的被控端能不能收。不能时提示原因，返回 false */
  canSendFile(): boolean {
    let reason = '';
    if (this.uploading) {
      reason = this.uploadIsFile ? '上一个文件还在发送' : '图片还在发送';
    } else if (this.peer === null || !this.peer.inputOpen) {
      reason = NOT_READY;
    } else if (this.state.fileMax <= 0) {
      reason = '电脑上的被控端版本太旧，更新到 0.9.0 以后才能发文件';
    }
    if (reason.length > 0) {
      this.toast(reason);
    }
    return reason.length === 0;
  }

  /** 选文件界面返回后调用；uri 为空串表示取消了 */
  endPickFile(uri: string): void {
    this.picking = false;
    if (uri.length > 0) {
      this.sendFile(uri);
    }
  }

  /** 进度条上的"取消"：不发了，电脑删掉已经收到的部分 */
  cancelUpload(): void {
    const up = this.state.upload;
    if (!this.fileUploading() || up === null || up.fileName === null || up.pasting) {
      return;
    }
    this.uploadCancelled = true;
    this.toast('已取消发送');
  }

  private async sendFile(uri: string): Promise<void> {
    if (!this.canSendFile()) {
      return;
    }
    const s = this.peer;
    const max = this.state.fileMax;
    if (s === null) {
      return;
    }
    this.uploading = true;
    this.uploadIsFile = true;
    this.uploadCancelled = false;
    this.state.upload = { sent: 0, total: 0, preparing: true, pasting: false, fileName: '' };
    let source: FileSource | null = null;
    try {
      try {
        source = FileSource.open(uri, max);
      } catch (e) {
        if (e instanceof FileTooLarge) {
          this.toast(`「${(e as FileTooLarge).fileName}」太大了，最大 ${FileUploads.limitText(max)}`);
        } else {
          Log.w(`读取文件失败：${errText(e as Object)}`);
          this.toast('读取文件失败');
        }
        return;
      }
      Log.i(`发送文件，${Math.round(source.size / 1024)} KB`);
      const text = await this.transferFile(s, source);
      if (!this.uploadCancelled) {
        this.toast(text);
      }
    } finally {
      source?.release();
      this.uploading = false;
      this.uploadIsFile = false;
      this.state.upload = null;
      if (!this.foreground) {
        BackgroundGuard.end();
      }
    }
  }

  /**
   * 经 file 通道分块发出文件并等电脑的回执，返回给用户看的结果。
   * 一边发一边算 SHA-256，发完交给电脑核对。中途取消、出错时告诉电脑删掉收到的部分。
   */
  private async transferFile(s: PeerSession, src: FileSource): Promise<string> {
    const total = src.size;
    const name = src.name;
    let lastShown = 0;
    const progress = (done: number, force: boolean) => {
      const now = Date.now();
      if (!force && now - lastShown < 100) {
        return;
      }
      lastShown = now;
      this.state.upload = { sent: done, total: total, preparing: false, pasting: false, fileName: name };
    };
    progress(0, true);

    if (!s.openFileChannel()) {
      return '没能和电脑建立传文件的通道';
    }
    const openBy = Date.now() + FileUploads.OPEN_TIMEOUT_MS;
    while (!s.fileOpen) {
      if (this.peer !== s || s.fileClosed) {
        return FILE_CLOSED;
      }
      if (Date.now() > openBy) {
        return '没能和电脑建立传文件的通道';
      }
      await delay(20);
    }

    const id = shortId('f');
    const waiter = new Waiter<FileReply>();
    this.fileWaiters.set(id, waiter);
    let ended = false;
    const digest = cryptoDigest();
    try {
      if (!s.sendFileText(fileBeginEvent(id, name, total))) {
        return FILE_CLOSED;
      }
      const stall = new StallWatch(FileUploads.STALL_MS);
      const buf = new ArrayBuffer(FileUploads.READ_BLOCK);
      let handed = 0;
      while (true) {
        if (this.uploadCancelled) {
          return '已取消发送';
        }
        const n = src.read(buf, handed);
        if (n <= 0) {
          break;
        }
        if (handed + n > total) {
          return '文件在发送过程中变了，没有发完';
        }
        const block = buf.slice(0, n);
        digest.updateSync({ data: new Uint8Array(block) });
        let off = 0;
        while (off < n) {
          if (this.uploadCancelled) {
            return '已取消发送';
          }
          if (this.peer !== s || !s.fileOpen) {
            return FILE_CLOSED;
          }
          // 电脑可能中途就回了错误（比如磁盘不够），不用再发了
          if (waiter.isCompleted) {
            return this.fileReplyText(await waiter.promise);
          }
          const buffered = s.fileBufferedAmount();
          const delivered = FileUploads.delivered(handed, buffered);
          if (stall.stalled(delivered, Date.now())) {
            return '传输卡住了，文件没有发完';
          }
          if (buffered > FileUploads.MAX_BUFFERED) {
            progress(delivered, false);
            await delay(10);
            continue;
          }
          const len = Math.min(FileUploads.CHUNK, n - off);
          if (!s.sendFileBinary(block.slice(off, off + len))) {
            return FILE_CLOSED;
          }
          off += len;
          handed += len;
        }
        progress(FileUploads.delivered(handed, s.fileBufferedAmount()), false);
      }
      if (handed !== total) {
        return '文件在发送过程中变了，没有发完';
      }
      const sha = FileUploads.hex(new Uint8Array(digest.digestSync().data));
      if (!s.sendFileText(fileEndEvent(id, sha))) {
        return FILE_CLOSED;
      }
      ended = true;
      // 通道里排着的还在往外发，进度条跟着走到头
      const tailStall = new StallWatch(FileUploads.STALL_MS);
      while (!waiter.isCompleted) {
        const buffered = s.fileBufferedAmount();
        if (buffered === 0) {
          break;
        }
        if (this.peer !== s || !s.fileOpen) {
          return FILE_CLOSED;
        }
        const delivered = FileUploads.delivered(handed, buffered);
        if (tailStall.stalled(delivered, Date.now())) {
          return '传输卡住了，文件没有发完';
        }
        progress(delivered, false);
        await delay(20);
      }
      this.state.upload = { sent: total, total: total, preparing: false, pasting: true, fileName: name };
      const reply = await withTimeout(waiter.promise, FileUploads.REPLY_TIMEOUT_MS);
      if (reply === null) {
        return '电脑没有回应，不知道文件存好没有';
      }
      if (reply.code === 'closed') {
        return '画面连接断开了，没等到电脑确认文件存好没有';
      }
      return this.fileReplyText(reply);
    } finally {
      this.fileWaiters.delete(id);
      // 走输入通道：file 通道里可能还排着上百 KB 的数据，取消排在后面要等它们发完才到
      if (!ended && this.peer === s) {
        s.sendInput(fileCancelEvent(id));
      }
    }
  }

  private fileReplyText(r: FileReply): string {
    const path = r.path;
    if (path === null) {
      return r.code === 'closed' ? FILE_CLOSED : this.errorText(r.code ?? 'unknown');
    }
    const shown = r.name ?? path.substring(path.lastIndexOf('\\') + 1);
    if (r.pasted) {
      return `「${shown}」已存到电脑，路径已粘贴到输入框`;
    }
    // 放进手机上的输入框：电脑能操作了（比如解锁以后），用户接着写要说的话，点"发送"连路径一起发出去
    this.state.inputFill = FileUploads.pathForInput(path);
    this.state.inputFillSeq++;
    return `「${shown}」已存到电脑，但路径没能粘贴（${FileUploads.pasteFailureText(r.code)}），已放进下面的输入框，接着写要说的话再点发送`;
  }

  // ------------------------------------------------------------------ 操作电脑：窗口平铺、锁定与解锁（协议 4.6、4.7、2.9）

  /**
   * 给电脑发一条和具体窗口无关的命令。连着画面时走数据通道（旧版被控端只认这条路）；
   * 没连画面时走信令通道（协议 2.9，被控端 0.9.6 起）。发不出去时提示原因，返回 false
   */
  private sendHostCommand(op: string, viaPeer: string): boolean {
    if (this.peer !== null && this.peer.sendInput(viaPeer)) {
      return true;
    }
    const host = this.hostCommandTarget();
    if (host.length === 0) {
      return false;
    }
    if (this.signaling.send(hostCmdMessage(host, op))) {
      return true;
    }
    this.toast('这台电脑不在线');
    return false;
  }

  /** 能经信令通道收命令的那台电脑；不行时提示原因，返回空串 */
  private hostCommandTarget(): string {
    const host = this.state.hostId;
    let reason = '';
    if (host.length === 0 || !this.authed || !this.state.hostOnline()) {
      reason = '这台电脑不在线';
    } else if (this.hostStates.has(host)) {
      return host;
    } else if (this.state.screen === Screens.Remote) {
      reason = NOT_READY;
    } else {
      reason = HostCommands.UNSUPPORTED_TOAST;
    }
    this.toast(reason);
    return '';
  }

  /** op：arrange 立即重排、raise 全部提到最前、pause 暂停、resume 恢复 */
  tile(op: string): void {
    if (!this.sendHostCommand(op, tileEvent(op))) {
      return;
    }
    if (op === 'arrange') {
      this.toast('已让电脑重排窗口');
    } else if (op === 'raise') {
      this.toast('已把所有会话窗口提到最前');
    }
  }

  /** 锁定电脑。只在用户明确点了才发；断开连接不会锁定 */
  lockPc(): void {
    this.sendHostCommand('lock', lockNowEvent());
  }

  /** 把用户这次输入的 Windows 密码或 PIN 发给电脑解锁。密码不保存 */
  async unlockPc(password: string): Promise<void> {
    if (password.length === 0 || this.state.unlocking) {
      return;
    }
    const s = this.peer !== null && this.peer.inputOpen ? this.peer : null;
    // 连着画面：密码走数据通道，端到端加密。没连画面：用电脑给的公钥加密后经服务器转发（协议 2.9）
    const waiter = s !== null ? this.unlockViaPeer(s, password) : this.unlockViaServer(password);
    if (waiter === null) {
      return;
    }
    this.state.unlocking = true;
    try {
      const code = await withTimeout(waiter.promise, UNLOCK_REPLY_TIMEOUT_MS);
      const text = HostCommands.unlockText(code);
      this.toast(text ?? this.errorText(code ?? ''));
    } finally {
      this.deleteWaiter(this.unlockWaiters, waiter);
      this.deleteWaiter(this.hostCmdWaiters, waiter);
      this.state.unlocking = false;
    }
  }

  private deleteWaiter(map: Map<string, Waiter<string>>, w: Waiter<string>): void {
    Array.from(map.keys()).forEach((k: string) => {
      if (map.get(k) === w) {
        map.delete(k);
      }
    });
  }

  private unlockViaPeer(s: PeerSession, password: string): Waiter<string> | null {
    const id = shortId('u');
    if (!s.sendInput(unlockEvent(id, password))) {
      this.toast(NOT_READY);
      return null;
    }
    const w = new Waiter<string>();
    this.unlockWaiters.set(id, w);
    return w;
  }

  private unlockViaServer(password: string): Waiter<string> | null {
    const host = this.hostCommandTarget();
    if (host.length === 0) {
      return null;
    }
    const key = this.hostStates.get(host)?.key ?? null;
    if (key === null) {
      this.toast('电脑上的被控端刚启动，还没准备好，过几秒再试');
      return null;
    }
    const r = UnlockCipher.encrypt(key, password);
    if (!r.ok) {
      this.toast(r.tooLong ? '密码太长，在这里发不了。请打开一个会话窗口，在画面页解锁' :
        '没能加密密码。请打开一个会话窗口，在画面页解锁');
      return null;
    }
    this.hostCmdSeq++;
    const req = `u${this.hostCmdSeq}`;
    if (!this.signaling.send(hostCmdMessage(host, 'unlock', req, r.enc))) {
      this.toast('这台电脑不在线');
      return null;
    }
    const w = new Waiter<string>();
    this.hostCmdWaiters.set(req, w);
    return w;
  }

  // ------------------------------------------------------------------ "全部会话"里折叠环境

  toggleGroup(key: string): void {
    const cur = this.state.collapsedGroups;
    const next = cur.includes(key) ? cur.filter((k: string) => k !== key) : cur.concat([key]);
    this.state.collapsedGroups = next;
    SettingsStore.saveCollapsedGroups(next);
  }

  // ------------------------------------------------------------------ 设置与统计

  updateSettings(transform: (s: AppSettings) => void): void {
    const next = this.state.settings.copy();
    transform(next);
    this.state.settings = next;
    SettingsStore.saveSettings(next);
    if (next.showStats && this.peer !== null) {
      this.startStats();
    }
  }

  /**
   * 统计：每秒读一次。没开"显示统计信息"时也在读，用来认出第一帧（解码出帧了就算出画面），
   * 出了画面又不显示统计时就停下。
   */
  private startStats(): void {
    this.clearTimer(this.statsTimer);
    this.statsTimer = setInterval(() => {
      const p = this.peer;
      if (p === null) {
        return;
      }
      p.getStats().then((report: webrtc.RTCStatsReport) => {
        if (this.peer !== p) {
          return;
        }
        const st = readStats(report, this.statsCursor);
        if (st !== null && st.framesDecoded > 0 && !this.state.hasVideo && this.videoTrack !== null) {
          this.state.hasVideo = true;
        }
        this.state.stats = this.state.settings.showStats && st !== null ? st.view : null;
        // 已经出了画面、又不显示统计：不用再读了，省电（打开"显示统计信息"时 updateSettings 会重新开始）
        if (this.state.hasVideo && !this.state.settings.showStats) {
          this.clearTimer(this.statsTimer);
          this.statsTimer = -1;
        }
      }).catch(() => {
      });
    }, 1000);
  }

  // ------------------------------------------------------------------ 工具

  toast(text: string): void {
    this.toastSink(text);
  }

  private clearTimer(id: number): void {
    if (id >= 0) {
      clearTimeout(id);
      clearInterval(id);
    }
  }

  errorText(code: string): string {
    switch (code) {
      case 'front-failed':
        return '电脑上无法把该窗口切到前台';
      case 'locked':
        return '电脑锁屏了，解锁后才能操作';
      case 'not-locked':
        return '电脑没有锁屏';
      case 'no-service':
        return '电脑上没装解锁服务';
      case 'bad-service':
        return '电脑上的解锁服务要重新安装（版本太旧或没通过核实）';
      case 'rate-limited':
        return '失败次数太多，15 分钟后再试';
      case 'still-locked':
        return '没解开，请检查密码或 PIN';
      case 'no-logon-screen':
        return '没找到电脑的登录界面，没有输入密码';
      case 'busy':
        return '正在解锁，请稍候';
      case 'failed':
        return '解锁失败';
      case 'covered':
        return '点击位置被电脑上的其它窗口挡住了';
      case 'window-gone':
        return '该窗口已关闭';
      case 'capture-failed':
        return '采集该窗口失败';
      case 'host-offline':
        return '这台电脑不在线';
      case 'image-too-large':
        return '图片太大了';
      case 'image-bad':
        return '图片数据有误，没能粘贴';
      case 'image-timeout':
        return '图片传输中断了';
      case 'closed':
        return '画面连接断开了，图片没有发出去';
      case 'file-too-large':
        return '文件太大了，电脑不收';
      case 'file-bad':
        return '文件传输出错，电脑没有保存';
      case 'file-timeout':
        return '文件传输中断了';
      case 'disk-full':
        return '电脑的磁盘空间不够了';
      case 'file-failed':
        return '电脑上保存文件失败';
      default:
        return `操作失败（${code}）`;
    }
  }
}

function cryptoDigest(): cryptoFramework.Md {
  return cryptoFramework.createMd('SHA256');
}

/** 进程里唯一的控制器 */
export const controller: RemoteController = new RemoteController();
