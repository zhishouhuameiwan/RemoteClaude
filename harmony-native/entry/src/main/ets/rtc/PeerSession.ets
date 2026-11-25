import webrtc from '@ohos/webrtc';
import {
  ChannelMessage, FileReply, IceCandidateSpec, IceServerSpec, ImageReply, LockState, TileState, UnlockResult,
  parseChannelMessage, parseFileReply
} from '../protocol/Protocol';
import { ClipAssembler } from '../protocol/ClipAssembler';
import { Log, errText } from '../common/Log';

export interface PeerCallbacks {
  onLocalIce: (candidate: IceCandidateSpec) => void;
  onVideoTrack: (track: webrtc.MediaStreamTrack) => void;
  onConnectionState: (state: string) => void;
  onInputOpen: () => void;
  onInputError: (code: string, detail: string | null) => void;
  onImageReply: (reply: ImageReply) => void;
  onLockState: (state: LockState) => void;
  onUnlockResult: (result: UnlockResult) => void;
  onTileState: (state: TileState) => void;
  /** 电脑能收文件，max 是大小上限（协议 4.8） */
  onFileCaps: (max: number) => void;
  onFileReply: (reply: FileReply) => void;
  /** 电脑上新复制了一段文字，已经拼完整（协议 4.9） */
  onClipboardText: (text: string) => void;
  /** 电脑上复制了文字但没有发过来，code 是原因（协议 4.9） */
  onClipboardSkipped: (code: string) => void;
}

const INPUT_LABEL = 'input';
const FILE_LABEL = 'file';

let sharedFactory: webrtc.PeerConnectionFactory | null = null;

/** 整个 App 共用一个工厂。解码器用库默认的：H264/H265 先试硬件，VP8/VP9/AV1 软件解 */
function factory(): webrtc.PeerConnectionFactory {
  if (sharedFactory === null) {
    sharedFactory = new webrtc.PeerConnectionFactory();
  }
  return sharedFactory;
}

/**
 * 与被控端之间的一条 WebRTC 连接，对照安卓端 rtc/PeerSession.kt。被控端发 offer，这里只做应答方（协议第 3 节）。
 * 连接关闭后的迟到回调直接丢弃。
 */
export class PeerSession {
  private pc: webrtc.RTCPeerConnection;
  private callbacks: PeerCallbacks;
  private input: webrtc.RTCDataChannel | null = null;
  /** 传文件的通道，第一次发文件时由这边建（协议 4.8） */
  private file: webrtc.RTCDataChannel | null = null;
  private clip: ClipAssembler = new ClipAssembler();
  private pendingIce: IceCandidateSpec[] = [];
  private remoteDescriptionSet: boolean = false;
  private closed: boolean = false;
  connectionState: string = 'new';

  constructor(iceServers: IceServerSpec[], callbacks: PeerCallbacks) {
    this.callbacks = callbacks;
    const servers: webrtc.RTCIceServer[] = iceServers.map((s: IceServerSpec): webrtc.RTCIceServer => {
      const server: webrtc.RTCIceServer = { urls: s.urls };
      if (s.username !== undefined) {
        server.username = s.username;
      }
      if (s.credential !== undefined) {
        server.credential = s.credential;
      }
      return server;
    });
    const config: webrtc.RTCConfiguration = {
      iceServers: servers,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    };
    this.pc = factory().createPeerConnection(config);
    this.pc.onicecandidate = (ev: webrtc.RTCPeerConnectionIceEvent) => {
      const c = ev.candidate;
      if (this.closed || c === undefined || c === null) {
        return;
      }
      this.callbacks.onLocalIce({
        candidate: c.candidate,
        sdpMid: c.sdpMid ?? null,
        sdpMLineIndex: c.sdpMLineIndex ?? 0
      });
    };
    this.pc.ontrack = (ev: webrtc.RTCTrackEvent) => {
      if (this.closed || ev.track.kind !== 'video') {
        return;
      }
      this.callbacks.onVideoTrack(ev.track);
    };
    this.pc.ondatachannel = (ev: webrtc.RTCDataChannelEvent) => {
      // 数据通道由被控端创建，标签是 input（协议第 3 节）。立即挂上回调，免得漏掉早到的消息
      const ch = ev.channel;
      if (this.closed || ch.label !== INPUT_LABEL) {
        return;
      }
      this.attachInput(ch);
    };
    this.pc.onconnectionstatechange = () => {
      if (this.closed) {
        return;
      }
      this.connectionState = this.pc.connectionState;
      this.callbacks.onConnectionState(this.connectionState);
    };
  }

  private attachInput(ch: webrtc.RTCDataChannel): void {
    ch.binaryType = 'arraybuffer';
    ch.onmessage = (ev: webrtc.MessageEvent<string | ArrayBuffer>) => {
      if (this.closed || typeof ev.data !== 'string') {
        return;
      }
      const msg: ChannelMessage | null = parseChannelMessage(ev.data as string);
      if (msg !== null) {
        this.dispatch(msg);
      }
    };
    ch.onopen = () => {
      if (!this.closed) {
        this.callbacks.onInputOpen();
      }
    };
    this.input = ch;
    if (ch.readyState === 'open') {
      this.callbacks.onInputOpen();
    }
  }

  private dispatch(msg: ChannelMessage): void {
    switch (msg.t) {
      case 'clip': {
        const whole = this.clip.add(msg.chunk);
        if (whole !== null) {
          this.callbacks.onClipboardText(whole);
        }
        break;
      }
      case 'clip-skip':
        this.callbacks.onClipboardSkipped(msg.code);
        break;
      case 'lock':
        this.callbacks.onLockState(msg.state);
        break;
      case 'tile-state':
        this.callbacks.onTileState(msg.state);
        break;
      case 'unlock-result':
        this.callbacks.onUnlockResult(msg.result);
        break;
      case 'image-reply':
        this.callbacks.onImageReply(msg.reply);
        break;
      case 'file-caps':
        this.callbacks.onFileCaps(msg.max);
        break;
      case 'err':
        this.callbacks.onInputError(msg.code, msg.detail);
        break;
    }
  }

  /** 设置被控端的 offer，生成并设置应答，返回应答 SDP */
  async acceptOffer(sdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: sdp });
    this.remoteDescriptionSet = true;
    // 对端描述设好之前收到的 ICE 候选，现在补上（协议第 3 节）
    const pending = this.pendingIce;
    this.pendingIce = [];
    for (const c of pending) {
      this.addIceNow(c);
    }
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer.sdp ?? '';
  }

  addRemoteIce(spec: IceCandidateSpec): void {
    if (this.closed || spec.candidate.trim().length === 0) {
      return;
    }
    if (this.remoteDescriptionSet) {
      this.addIceNow(spec);
    } else {
      this.pendingIce.push(spec);
    }
  }

  private addIceNow(spec: IceCandidateSpec): void {
    const init: webrtc.RTCIceCandidateInit = {
      candidate: spec.candidate,
      sdpMid: spec.sdpMid ?? '0',
      sdpMLineIndex: spec.sdpMLineIndex
    };
    this.pc.addIceCandidate(init).catch((e: Object) => {
      Log.w(`添加 ICE 候选失败：${errText(e)}`);
    });
  }

  get inputOpen(): boolean {
    return this.input !== null && this.input.readyState === 'open';
  }

  /** 通过数据通道发一条文本消息。必须是文本帧：被控端按字符串解析，二进制帧会被丢弃 */
  sendInput(text: string): boolean {
    const ch = this.input;
    if (ch === null || ch.readyState !== 'open') {
      return false;
    }
    try {
      ch.send(text);
      return true;
    } catch (e) {
      Log.w(`数据通道发送失败：${errText(e as Object)}`);
      return false;
    }
  }

  /** 通过 input 通道发一段二进制数据（图片分块，协议 4.5） */
  sendBinary(data: ArrayBuffer): boolean {
    const ch = this.input;
    if (ch === null || ch.readyState !== 'open') {
      return false;
    }
    try {
      ch.send(data);
      return true;
    } catch (e) {
      Log.w(`数据通道发送失败：${errText(e as Object)}`);
      return false;
    }
  }

  /** input 通道里排队还没发出去的字节数 */
  bufferedAmount(): number {
    const ch = this.input;
    return ch !== null && ch.readyState === 'open' ? ch.bufferedAmount : 0;
  }

  /**
   * 传文件的通道（标签 file，有序可靠）。第一次调用时建，之后返回同一条；建好后要等 fileOpen 才能发。
   */
  openFileChannel(): boolean {
    if (this.closed) {
      return false;
    }
    if (this.file !== null) {
      return true;
    }
    try {
      const init: webrtc.RTCDataChannelInit = { ordered: true };
      const ch = this.pc.createDataChannel(FILE_LABEL, init);
      ch.binaryType = 'arraybuffer';
      ch.onmessage = (ev: webrtc.MessageEvent<string | ArrayBuffer>) => {
        if (this.closed || typeof ev.data !== 'string') {
          return;
        }
        const reply = parseFileReply(ev.data as string);
        if (reply !== null) {
          this.callbacks.onFileReply(reply);
        }
      };
      this.file = ch;
      return true;
    } catch (e) {
      Log.w(`建文件通道失败：${errText(e as Object)}`);
      return false;
    }
  }

  get fileOpen(): boolean {
    return this.file !== null && this.file.readyState === 'open';
  }

  /** file 通道已经关了（或建不起来），这条连接上发不了文件了 */
  get fileClosed(): boolean {
    const s = this.file?.readyState;
    return s === 'closing' || s === 'closed';
  }

  sendFileText(text: string): boolean {
    const ch = this.file;
    if (ch === null || ch.readyState !== 'open') {
      return false;
    }
    try {
      ch.send(text);
      return true;
    } catch (e) {
      return false;
    }
  }

  sendFileBinary(data: ArrayBuffer): boolean {
    const ch = this.file;
    if (ch === null || ch.readyState !== 'open') {
      return false;
    }
    try {
      ch.send(data);
      return true;
    } catch (e) {
      return false;
    }
  }

  fileBufferedAmount(): number {
    const ch = this.file;
    return ch !== null && ch.readyState === 'open' ? ch.bufferedAmount : 0;
  }

  getStats(): Promise<webrtc.RTCStatsReport> {
    return this.pc.getStats();
  }

  /** 关闭连接并释放原生资源。调用前要先把渲染器从视频轨道上摘下来 */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      this.input?.close();
      this.file?.close();
    } catch (e) {
      // 通道可能已经关了
    }
    this.input = null;
    this.file = null;
    try {
      this.pc.close();
    } catch (e) {
      Log.w(`关闭连接出错：${errText(e as Object)}`);
    }
  }
}
