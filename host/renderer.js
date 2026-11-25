'use strict';
/**
 * 被控端页面：连接信令服务器，按控制端的选择采集某个 Claude 窗口，
 * 通过 WebRTC 把画面推过去，并把数据通道里收到的输入事件交给主进程注入。
 */
const bridge = window.rc; // 由 preload.js 暴露；不能再声明同名的顶层变量
const $ = (id) => document.getElementById(id);

let cfg = null;
let ws = null;
let iceServers = [];
let backoff = 1000;
let stopped = true; // 未登录、被顶替、退出登录时不自动重连
let reconnectTimer = null;

/**
 * viewerId -> { pc, dc, sender, stream, hwnd, title }
 * 每个控制端一条独立的 WebRTC 连接，各自可以选不同的窗口。
 */
const peers = new Map();
/** 电脑是否锁屏、能否从控制端解锁（协议文档 4.6），主进程有变化时推过来 */
let lockState = { locked: false, unlock: false, untrusted: false };
/** 窗口平铺是否在运行、是否暂停（协议文档 4.7） */
let tileState = { available: false, paused: false };
const pendingIce = new Map(); // 对端应答到达前先收到的 ICE 候选

function log(...args) {
  const line = `${new Date().toLocaleTimeString()} ${args.join(' ')}`;
  const el = $('log');
  el.textContent += line + '\n';
  if (el.textContent.length > 20000) el.textContent = el.textContent.slice(-15000);
  el.scrollTop = el.scrollHeight;
}

function setStatus(kind, text) {
  $('dot').className = 'dot ' + kind;
  $('status').textContent = text;
  bridge.setStatus(kind, text); // 同步到托盘图标和提示文字
}

function renderViewers() {
  const el = $('viewers');
  el.textContent = '';
  if (!peers.size) {
    el.textContent = '暂无';
    el.classList.add('muted');
  } else {
    el.classList.remove('muted');
    for (const [id, p] of peers) {
      const row = document.createElement('div');
      row.className = 'viewer';
      const a = document.createElement('span');
      a.textContent = p.title || '(未选择窗口)';
      const b = document.createElement('span');
      b.textContent = `${id} · ${p.pc.connectionState}`;
      row.append(a, b);
      el.append(row);
    }
  }
  bridge.setActive(peers.size);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------------------------------------------------------------- 信令

async function connect() {
  clearTimeout(reconnectTimer);
  if (stopped) return;
  const token = await bridge.getToken();
  // 等令牌的时候可能已经断开了（退出登录、正在换服务器），不能再连
  if (stopped) return;
  if (!token) {
    showLogin('请先登录');
    return;
  }
  setStatus('wait', '正在连接服务器…');
  const sock = new WebSocket(cfg.server);
  ws = sock;
  sock.onopen = () => send({ type: 'auth', role: 'host', token, proto: 2, client: `host/${cfg.version}` });
  sock.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(msg).catch((err) => log('处理消息出错:', err.message));
  };
  sock.onclose = () => {
    if (ws !== sock || stopped) return;
    setStatus('off', '与服务器的连接已断开，稍后重试');
    reconnectTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 15000);
  };
  sock.onerror = () => {};
}

/** 停止连接并关掉所有画面连接（退出登录、令牌失效、被顶替时） */
function disconnect() {
  stopped = true;
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  for (const id of [...peers.keys()]) closePeer(id);
}

async function onMessage(msg) {
  switch (msg.type) {
    case 'auth-ok': {
      iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
      backoff = 1000;
      setStatus('on', '已上线，等待远程连接');
      log(`已连接服务器，账号 ${msg.email}`);
      // 断线期间离开的控制端，清掉它们残留的连接
      const alive = new Set(msg.viewers || []);
      for (const id of [...peers.keys()]) if (!alive.has(id)) closePeer(id);
      viewers.clear();
      for (const id of alive) {
        viewers.add(id);
        sendHostState(id);
        sendApprovals(id);
      }
      break;
    }
    case 'auth-fail':
      log('鉴权失败:', msg.reason);
      if (msg.reason === 'locked') {
        setStatus('off', '连接失败次数太多，15 分钟后自动重试');
        backoff = 15 * 60 * 1000;
      } else if (msg.reason === 'bad-proto') {
        disconnect();
        setStatus('off', '被控端版本太旧，和服务器不兼容，请更新');
      } else {
        // 令牌失效（在别处退出、重置了密码、长期没用过期）：回到登录页
        disconnect();
        await bridge.sessionInvalid();
        showLogin('登录已失效，请重新登录');
      }
      break;
    case 'replaced':
      disconnect();
      setStatus('off', '这台电脑在别处又启动了一个被控端，本窗口已下线');
      $('reconnect').hidden = false;
      log('同一台电脑上的另一个被控端连上了服务器，本窗口已下线');
      break;
    case 'viewer-join':
      log(`控制端 ${msg.id} 已连接`);
      viewers.add(msg.id);
      sendHostState(msg.id);
      sendApprovals(msg.id);
      break;
    case 'viewer-leave':
      log(`控制端 ${msg.id} 已断开`);
      updateWatchers.delete(msg.id);
      viewers.delete(msg.id);
      closePeer(msg.id);
      break;
    case 'list':
      // 控制端说缩略图可以后补时，先回不带图的列表，截完图再补一份（winlist.js）
      await RcWinList.reply(msg, bridge.listWindows, send);
      break;
    case 'select':
      await startCapture(msg.from, msg.hwnd);
      break;
    case 'list-sessions': {
      const r = (await bridge.listSessions()) || { available: false, reason: 'failed', groups: [] };
      send({ type: 'sessions', to: msg.from, ...r });
      break;
    }
    case 'open-session':
    case 'new-session':
      await openSession(msg);
      break;
    case 'close-window':
      await closeWindow(msg);
      break;
    case 'host-update':
      await hostUpdate(msg);
      break;
    case 'approval-answer':
      await answerApproval(msg);
      break;
    case 'host-cmd': {
      const reply = await RcHostCmd.run(msg, bridge, log);
      if (reply) send(reply);
      break;
    }
    case 'answer': {
      const p = peers.get(msg.from);
      if (!p || !msg.sdp) break;
      // 控制端的 answer 里补上起步码率，打开画面后不用从 300kbps 慢慢爬（sdp.js）
      const sdp = typeof msg.sdp.sdp === 'string' ? { type: msg.sdp.type, sdp: RcSdp.withStartBitrate(msg.sdp.sdp, cfg.startBitrateKbps) } : msg.sdp;
      await p.pc.setRemoteDescription(sdp);
      for (const c of pendingIce.get(msg.from) || []) await p.pc.addIceCandidate(c).catch(() => {});
      pendingIce.delete(msg.from);
      break;
    }
    case 'ice': {
      const p = peers.get(msg.from);
      if (!p || !msg.candidate) break;
      if (p.pc.remoteDescription) {
        await p.pc.addIceCandidate(msg.candidate).catch(() => {});
      } else {
        if (!pendingIce.has(msg.from)) pendingIce.set(msg.from, []);
        pendingIce.get(msg.from).push(msg.candidate);
      }
      break;
    }
    case 'stop':
      closePeer(msg.from);
      break;
    default:
  }
}

// ---------------------------------------------------------------- 采集与推流

async function captureWindow(sourceId) {
  // Electron 里按采集源 id 直接取窗口画面，不弹系统的选择框
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: cfg.maxFps,
        maxWidth: 8192,
        maxHeight: 8192,
      },
    },
  });
}

/** 把指定编码排到最前面，让协商优先选它 */
function preferCodec(transceiver, name) {
  if (!name || name === 'auto' || !transceiver.setCodecPreferences) return;
  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps) return;
  const want = 'video/' + name.toLowerCase();
  const first = caps.codecs.filter((c) => c.mimeType.toLowerCase() === want);
  if (!first.length) return;
  const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== want);
  try {
    transceiver.setCodecPreferences([...first, ...rest]);
  } catch (err) {
    log('设置编码偏好失败:', err.message);
  }
}

async function startCapture(viewerId, hwnd) {
  let info;
  try {
    info = await bridge.prepareCapture(hwnd);
  } catch (err) {
    log(`采集窗口 ${hwnd} 失败:`, err.message);
    send({ type: 'error', to: viewerId, code: 'capture-failed' });
    return;
  }
  let stream = null;
  try {
    stream = await captureWindow(info.sourceId);
  } catch (err) {
    log(`采集窗口 ${hwnd} 失败:`, err.message);
    // 锁屏时采集不了窗口，但连接还要建：控制端要靠数据通道看到锁屏、发解锁（协议文档 4.6）
    if (!lockState.locked) {
      send({ type: 'error', to: viewerId, code: 'capture-failed' });
      return;
    }
    log('电脑锁屏了，先只建连接，解锁后再出画面');
  }
  const track = stream ? stream.getVideoTracks()[0] : null;
  if (track) {
    track.contentHint = 'text'; // 界面以文字为主：宁可降帧率也要保清晰度
    track.onended = () => onTrackEnded(viewerId, stream, info.title);
  }

  const existing = peers.get(viewerId);
  if (existing && ['new', 'connecting', 'connected'].includes(existing.pc.connectionState)) {
    // 已经连着：直接换轨道，不用重新协商，切换会话几乎没有停顿
    await existing.sender.replaceTrack(track);
    if (existing.stream) existing.stream.getTracks().forEach((t) => t.stop());
    bridge.release(viewerId);
    Object.assign(existing, { stream, hwnd, title: info.title, videoLost: !track });
    send({ type: 'selected', to: viewerId, hwnd, title: info.title });
    log(`控制端 ${viewerId} 切换到「${info.title}」`);
    renderViewers();
    return;
  }
  if (existing) closePeer(viewerId);

  const pc = new RTCPeerConnection({ iceServers });
  const peer = { pc, dc: null, fc: null, file: null, sender: null, stream, hwnd, title: info.title, videoLost: !track };
  peers.set(viewerId, peer);
  // 传文件的数据通道由控制端在要发文件时创建（协议文档 4.8）。网页控制端不认通道标签，被控端多建一条会把它弄乱
  pc.ondatachannel = (e) => {
    if (e.channel.label === 'file') setupFileChannel(viewerId, peer, e.channel);
  };

  // 没有画面时也建视频通道，解锁后 replaceTrack 就能出画面，不用重新协商
  const transceiver = pc.addTransceiver(track || 'video', {
    direction: 'sendonly',
    streams: stream ? [stream] : [],
    sendEncodings: [{ maxBitrate: cfg.maxBitrateKbps * 1000, maxFramerate: cfg.maxFps }],
  });
  peer.sender = transceiver.sender;
  preferCodec(transceiver, cfg.codec);
  try {
    const params = peer.sender.getParameters();
    params.degradationPreference = 'maintain-resolution';
    await peer.sender.setParameters(params);
  } catch {
    /* 老版本不支持就算了 */
  }

  const dc = pc.createDataChannel('input', { ordered: true });
  dc.binaryType = 'arraybuffer';
  peer.dc = dc;
  dc.onmessage = (e) => {
    if (typeof e.data !== 'string') return imageChunk(viewerId, peer, e.data);
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    // 锁定、解锁不排在传图队列里（协议文档 4.6）
    if (ev.t === 'lock-now') return lockNow(viewerId);
    if (ev.t === 'unlock') return unlock(viewerId, peer, ev);
    if (ev.t === 'tile') return tile(viewerId, ev);
    // 取消发文件走输入通道，不用排在 file 通道里还没发完的数据后面（协议文档 4.8）
    if (ev.t === 'file-cancel') return fileCancel(viewerId, peer, ev);
    if (ev.t === 'img') return imageBegin(viewerId, peer, ev);
    if (ev.t === 'img-end') return imageEnd(viewerId, peer, ev);
    // 传图期间的输入先存着，等图片粘贴完再按顺序执行（协议文档 4.5）
    if (peer.upload) {
      if (peer.upload.queued.length < MAX_QUEUED) peer.upload.queued.push(ev);
      return;
    }
    bridge.input(viewerId, peer.hwnd, ev);
  };
  dc.onopen = () => {
    sendToViewer(peer, lockMessage());
    sendToViewer(peer, tileMessage());
    // 告诉控制端能收文件，以及大小上限（协议文档 4.8）；旧版控制端不认这条，会忽略
    sendToViewer(peer, { t: 'file-caps', max: cfg.fileMax });
  };
  dc.onclose = () => {
    dropImage(peer);
    bridge.release(viewerId);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'ice', to: viewerId, candidate: e.candidate });
  };
  pc.onconnectionstatechange = () => {
    log(`控制端 ${viewerId} 连接状态: ${pc.connectionState}`);
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(viewerId);
    else renderViewers();
  };

  await pc.setLocalDescription(await pc.createOffer());
  send({ type: 'offer', to: viewerId, sdp: pc.localDescription, hwnd, title: info.title });
  log(`控制端 ${viewerId} 开始查看「${info.title}」`);
  renderViewers();
}

// ---------------------------------------------------------------- 粘贴图片（协议文档 4.5）

const IMAGE_MAX = 10 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 30000;
const MAX_QUEUED = 2000;
const IMAGE_ID = /^[A-Za-z0-9]{1,32}$/;

function sendToViewer(peer, msg) {
  if (peer.dc && peer.dc.readyState === 'open') peer.dc.send(JSON.stringify(msg));
}

/** 结束当前这张图的接收，把期间存下的输入交给主进程。返回被结束的那张，没有时返回 null */
function finishImage(viewerId, peer) {
  const up = peer.upload;
  if (!up) return null;
  clearTimeout(up.timer);
  peer.upload = null;
  for (const ev of up.queued) bridge.input(viewerId, peer.hwnd, ev);
  return up;
}

/** 数据通道关了：连同存下的输入一起丢掉 */
function dropImage(peer) {
  if (!peer.upload) return;
  clearTimeout(peer.upload.timer);
  peer.upload = null;
}

function armImageTimer(viewerId, peer) {
  const up = peer.upload;
  clearTimeout(up.timer);
  up.timer = setTimeout(() => {
    if (peer.upload !== up) return;
    log(`控制端 ${viewerId} 的图片传到一半中断了`);
    sendToViewer(peer, { t: 'err', code: 'image-timeout', id: up.id });
    finishImage(viewerId, peer);
  }, IMAGE_TIMEOUT_MS);
}

function imageBegin(viewerId, peer, ev) {
  if (typeof ev.id !== 'string' || !IMAGE_ID.test(ev.id)) return;
  finishImage(viewerId, peer); // 上一张没传完就来了新的：丢掉上一张，它之后存下的输入照常执行
  const size = ev.size;
  if (ev.mime !== 'image/png' && ev.mime !== 'image/jpeg') return sendToViewer(peer, { t: 'err', code: 'image-bad', id: ev.id });
  if (!Number.isInteger(size) || size <= 0) return sendToViewer(peer, { t: 'err', code: 'image-bad', id: ev.id });
  if (size > IMAGE_MAX) return sendToViewer(peer, { t: 'err', code: 'image-too-large', id: ev.id });
  peer.upload = { id: ev.id, size, received: 0, chunks: [], queued: [], timer: 0 };
  armImageTimer(viewerId, peer);
}

function imageChunk(viewerId, peer, data) {
  const up = peer.upload;
  if (!up || !(data instanceof ArrayBuffer)) return;
  up.received += data.byteLength;
  // 超出声明的大小就不再保存，到 img-end 时按字节数不对回报
  if (up.received <= up.size) up.chunks.push(new Uint8Array(data));
  armImageTimer(viewerId, peer);
}

function imageEnd(viewerId, peer, ev) {
  const up = peer.upload;
  if (!up || ev.id !== up.id) return;
  clearTimeout(up.timer);
  peer.upload = null;
  if (up.received !== up.size) {
    sendToViewer(peer, { t: 'err', code: 'image-bad', id: up.id });
  } else {
    const bytes = new Uint8Array(up.size);
    let offset = 0;
    for (const c of up.chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
    // 先把粘贴交给主进程排队，再交存下的输入，主进程按到达顺序串行执行
    bridge.pasteImage(viewerId, peer.hwnd, bytes).then((code) => {
      if (code) {
        log(`控制端 ${viewerId} 的图片没能粘贴: ${code}`);
        sendToViewer(peer, { t: 'err', code, id: up.id });
      } else {
        log(`控制端 ${viewerId} 粘贴了一张图片（${Math.round(up.size / 1024)} KB）`);
        sendToViewer(peer, { t: 'img-ok', id: up.id });
      }
    });
  }
  for (const q of up.queued) bridge.input(viewerId, peer.hwnd, q);
}

// ---------------------------------------------------------------- 接收文件（协议文档 4.8）
//
// 文件走控制端建的 file 通道，和输入通道分开：大文件传好几分钟，期间点击、滚动、打字照常，不用排在文件后面。
// 数据块攒到 FILE_FLUSH_BYTES 再交给主进程写盘，主进程核对后存成正式文件、把路径粘贴进当前查看的窗口。

const FILE_TIMEOUT_MS = 30000;
const FILE_FLUSH_BYTES = 512 * 1024;
const FILE_ID = /^[A-Za-z0-9]{1,32}$/;

function setupFileChannel(viewerId, peer, fc) {
  if (peer.fc && peer.fc !== fc) {
    dropFile(viewerId, peer);
    try {
      peer.fc.close();
    } catch {
      /* ignore */
    }
  }
  fc.binaryType = 'arraybuffer';
  peer.fc = fc;
  fc.onmessage = (e) => {
    if (peers.get(viewerId) !== peer || peer.fc !== fc) return;
    if (typeof e.data !== 'string') return fileChunk(viewerId, peer, e.data);
    let ev;
    try {
      ev = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    if (ev.t === 'file') fileBegin(viewerId, peer, ev);
    else if (ev.t === 'file-end') fileEnd(viewerId, peer, ev);
    else if (ev.t === 'file-cancel') fileCancel(viewerId, peer, ev);
  };
  fc.onclose = () => {
    if (peer.fc !== fc) return;
    peer.fc = null;
    dropFile(viewerId, peer);
  };
}

function replyFile(peer, msg) {
  if (peer.fc && peer.fc.readyState === 'open') peer.fc.send(JSON.stringify(msg));
}

/** 不收这个文件了（取消、超时、连接断开、来了新的）：主进程删掉临时文件 */
function dropFile(viewerId, peer) {
  const up = peer.file;
  if (!up) return;
  clearTimeout(up.timer);
  peer.file = null;
  bridge.fileAbort(viewerId);
}

/** 控制端不发了；之后还在路上的数据块对不上正在收的文件，会被忽略 */
function fileCancel(viewerId, peer, ev) {
  if (!peer.file || ev.id !== peer.file.id) return;
  log(`控制端 ${viewerId} 取消了文件「${peer.file.name}」`);
  dropFile(viewerId, peer);
}

function failFile(viewerId, peer, code) {
  const up = peer.file;
  if (!up) return;
  log(`控制端 ${viewerId} 的文件「${up.name}」没收成: ${code}`);
  dropFile(viewerId, peer);
  replyFile(peer, { t: 'err', code, id: up.id });
}

function armFileTimer(viewerId, peer) {
  const up = peer.file;
  clearTimeout(up.timer);
  up.timer = setTimeout(() => {
    if (peer.file === up) failFile(viewerId, peer, 'file-timeout');
  }, FILE_TIMEOUT_MS);
}

function fileBegin(viewerId, peer, ev) {
  if (typeof ev.id !== 'string' || !FILE_ID.test(ev.id)) return;
  dropFile(viewerId, peer); // 上一个没传完就来了新的：丢掉上一个
  const size = ev.size;
  if (!Number.isSafeInteger(size) || size < 0 || typeof ev.name !== 'string') {
    return replyFile(peer, { t: 'err', code: 'file-bad', id: ev.id });
  }
  if (size > cfg.fileMax) return replyFile(peer, { t: 'err', code: 'file-too-large', id: ev.id });
  const up = { id: ev.id, name: ev.name, size, received: 0, pending: [], pendingBytes: 0, timer: 0 };
  peer.file = up;
  armFileTimer(viewerId, peer);
  log(`控制端 ${viewerId} 开始发文件「${ev.name}」（${sizeText(size)}）`);
  bridge.fileBegin(viewerId, ev.id, ev.name, size).then((code) => {
    // 电脑这边收不了（磁盘不够等）：马上告诉控制端，它就不用把整个文件传完
    if (code && peer.file === up) failFile(viewerId, peer, code);
  });
}

function flushFile(viewerId, up) {
  if (!up.pendingBytes) return;
  const bytes = new Uint8Array(up.pendingBytes);
  let offset = 0;
  for (const c of up.pending) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  up.pending = [];
  up.pendingBytes = 0;
  bridge.fileData(viewerId, up.id, bytes);
}

function fileChunk(viewerId, peer, data) {
  const up = peer.file;
  if (!up || !(data instanceof ArrayBuffer)) return;
  up.received += data.byteLength;
  if (up.received > up.size) return failFile(viewerId, peer, 'file-bad');
  up.pending.push(new Uint8Array(data));
  up.pendingBytes += data.byteLength;
  if (up.pendingBytes >= FILE_FLUSH_BYTES) flushFile(viewerId, up);
  armFileTimer(viewerId, peer);
}

function fileEnd(viewerId, peer, ev) {
  const up = peer.file;
  if (!up || ev.id !== up.id) return;
  clearTimeout(up.timer);
  peer.file = null;
  if (up.received !== up.size) {
    bridge.fileAbort(viewerId);
    log(`控制端 ${viewerId} 的文件「${up.name}」字节数不对`);
    return replyFile(peer, { t: 'err', code: 'file-bad', id: up.id });
  }
  flushFile(viewerId, up);
  // 粘贴到收完时正在查看的窗口
  bridge.fileEnd(viewerId, up.id, typeof ev.sha256 === 'string' ? ev.sha256 : '', peer.hwnd).then(
    (r) => {
      if (!r || !r.path) {
        log(`控制端 ${viewerId} 的文件「${up.name}」没存成: ${(r && r.code) || 'file-failed'}`);
        return replyFile(peer, { t: 'err', code: (r && r.code) || 'file-failed', id: up.id });
      }
      log(`收到控制端 ${viewerId} 的文件 ${r.path}（${sizeText(up.size)}）${r.pasted ? '，已粘贴路径' : `，路径没能粘贴: ${r.code}`}`);
      const msg = { t: 'file-ok', id: up.id, path: r.path, name: r.name, pasted: !!r.pasted };
      if (!r.pasted) msg.code = r.code || 'failed';
      replyFile(peer, msg);
    },
    () => replyFile(peer, { t: 'err', code: 'file-failed', id: up.id })
  );
}

function sizeText(bytes) {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/**
 * 采集的画面停了：窗口真关了就通知控制端；窗口还在（多半是电脑锁屏了）就保留连接，
 * 数据通道还能用来解锁，解锁后重新采集。
 */
async function onTrackEnded(viewerId, stream, title) {
  const p = peers.get(viewerId);
  if (!p || p.stream !== stream || reportedClosed.has(stream)) return;
  const state = await bridge.windowState(p.hwnd);
  if (peers.get(viewerId) !== p || p.stream !== stream) return;
  if (state && state.alive) {
    p.videoLost = true;
    log(`「${title}」的画面停了${state.locked ? '（电脑锁屏了），解锁后自动恢复' : '，重新采集'}`);
    if (!state.locked) restartVideo(viewerId, p);
    return;
  }
  log(`窗口「${title}」已关闭`);
  send({ type: 'window-closed', to: viewerId });
}

function restartVideo(viewerId, p) {
  if (!p.videoLost) return;
  p.videoLost = false;
  startCapture(viewerId, p.hwnd);
}

function closePeer(viewerId) {
  const p = peers.get(viewerId);
  if (!p) return;
  peers.delete(viewerId);
  dropImage(p);
  dropFile(viewerId, p);
  pendingIce.delete(viewerId);
  bridge.release(viewerId);
  if (p.stream) p.stream.getTracks().forEach((t) => t.stop());
  try {
    p.pc.close();
  } catch {
    /* ignore */
  }
  renderViewers();
}

// ---------------------------------------------------------------- 锁定与解锁（协议文档 4.6）

function lockMessage() {
  const msg = { t: 'lock', locked: lockState.locked, unlock: lockState.unlock };
  if (lockState.untrusted) msg.untrusted = true; // 只在是 true 时带，旧控制端不认这个字段
  return msg;
}

bridge.getLockState().then((s) => {
  if (s) lockState = s;
  broadcastHostState();
});

bridge.onLockState((s) => {
  const wasLocked = lockState.locked;
  const wasUntrusted = lockState.untrusted;
  lockState = s;
  if (s.untrusted && !wasUntrusted) log('解锁服务要重新安装：管道那头的服务核实不过（多半是旧版），手机上解不了锁，见 docs/06');
  if (s.locked !== wasLocked) {
    const how = s.unlock ? '（可以从控制端解锁）' : s.untrusted ? '（解锁服务要重新安装）' : '（没装解锁服务）';
    log(s.locked ? '电脑已锁屏' + how : '电脑已解锁');
  }
  const msg = lockMessage();
  for (const p of peers.values()) sendToViewer(p, msg);
  broadcastHostState();
  // 解锁了：锁屏期间停掉的画面重新采集
  if (wasLocked && !s.locked) {
    for (const [id, p] of peers) restartVideo(id, p);
  }
});

// ---------------------------------------------------------------- 剪贴板回传（协议文档 4.9）

// 主进程发现电脑上新复制了文字，整理成 clip 消息交过来，这里发给每个连着数据通道的控制端。
// 内容不写进页面日志
bridge.onClipboard((msgs) => {
  if (!Array.isArray(msgs)) return;
  for (const p of peers.values()) {
    for (const m of msgs) sendToViewer(p, m);
  }
});

// ---------------------------------------------------------------- 窗口平铺（协议文档 4.7）

function tileMessage() {
  return { t: 'tile-state', available: tileState.available, paused: tileState.paused };
}

bridge.getTileState().then((s) => {
  if (s) tileState = s;
  broadcastHostState();
});

bridge.onTileState((s) => {
  tileState = s;
  const msg = tileMessage();
  for (const p of peers.values()) sendToViewer(p, msg);
  broadcastHostState();
});

const TILE_OPS = RcHostCmd.TILE_OPS;

function tile(viewerId, ev) {
  if (!Object.prototype.hasOwnProperty.call(TILE_OPS, ev.op)) return;
  log(`控制端 ${viewerId} 要求${TILE_OPS[ev.op]}`);
  bridge.tile(ev.op);
}

// ---------------------------------------------------------------- 电脑状态、不连画面的命令（协议文档 2.9）
//
// 上面两节的锁屏、平铺状态只发给正在看画面的控制端（数据通道）。这里再经信令通道推给账号下所有连着的控制端，
// 它们停在会话列表时也知道电脑锁没锁、平铺开没开；命令 host-cmd 的处理在 hostcmd.js。

/** 解锁密码用的公钥（主进程每次启动生成），还没生成好时为 null */
let hostKey = null;

function sendHostState(viewerId) {
  send(RcHostCmd.stateMessage(viewerId, lockState, tileState, hostKey));
}

function broadcastHostState() {
  for (const id of viewers) sendHostState(id);
}

bridge.getHostKey().then((k) => {
  if (!k) return;
  hostKey = k;
  broadcastHostState();
});

bridge.onHostKey((k) => {
  hostKey = k;
  broadcastHostState();
});

// ---------------------------------------------------------------- 手机审批（协议文档 2.7，说明见 docs/09）

/** 账号下连着的控制端（不只是在看画面的），审批要推给它们 */
const viewers = new Set();
let approvalList = [];

function sendApprovals(viewerId) {
  send({ type: 'approvals', to: viewerId, list: approvalList });
}

bridge.getApprovals().then((list) => {
  approvalList = Array.isArray(list) ? list : [];
  for (const id of viewers) sendApprovals(id);
});

bridge.onApprovals((list) => {
  const added = list.filter((x) => !approvalList.some((y) => y.id === x.id));
  approvalList = list;
  for (const x of added) log(`新的${x.kind === 'ask' ? '提问' : '审批'}：「${x.title}」${x.kind === 'ask' ? '' : x.tool}`);
  for (const id of viewers) sendApprovals(id);
});

async function answerApproval(msg) {
  const id = typeof msg.id === 'string' ? msg.id : '';
  const req = typeof msg.req === 'string' ? msg.req.slice(0, 40) : '';
  const r = (await bridge.answerApproval(id, { choice: msg.choice, text: msg.text, answers: msg.answers })) || { ok: false, code: 'failed' };
  if (!r.ok) log(`控制端 ${msg.from} 的审批答案没生效: ${r.code}`);
  send({ type: 'approval-result', to: msg.from, id, req, ok: !!r.ok, code: r.code || '' });
}

// ---------------------------------------------------------------- 被控端升级（协议文档 2.6）

/** 问过升级状态的控制端；状态有变化时推给它们 */
const updateWatchers = new Set();

function updateMessage(to, s) {
  return { type: 'host-update-state', to, version: s.version, status: s.status, newVersion: s.newVersion, percent: s.percent };
}

async function hostUpdate(msg) {
  const op = ['status', 'check', 'install'].includes(msg.op) ? msg.op : 'status';
  if (op !== 'status') log(`控制端 ${msg.from} 要${op === 'install' ? '马上升级被控端' : '检查被控端更新'}`);
  const s = op === 'status' ? await bridge.getUpdateState() : await bridge.update(op);
  if (!s) return;
  updateWatchers.add(msg.from);
  send(updateMessage(msg.from, s));
}

bridge.onUpdateState((s) => {
  for (const id of updateWatchers) send(updateMessage(id, s));
});

// ---------------------------------------------------------------- 打开、新建 Claude 会话（协议文档 2.5）

/** 控制端要打开一个会话或新建一个：在电脑上把它开成单独窗口，回 session-opened，控制端再 select 这个窗口 */
async function openSession(msg) {
  const req = typeof msg.req === 'string' ? msg.req.slice(0, 40) : '';
  const isNew = msg.type === 'new-session';
  log(`控制端 ${msg.from} 要${isNew ? '新建' : '打开'}会话`);
  const r = isNew ? await bridge.newSession(msg.env) : await bridge.openSession(msg.session);
  if (r && r.ok) {
    log(`会话窗口「${r.title}」${isNew ? '已新建' : r.created ? '已打开' : '本来就开着'}`);
    send({
      type: 'session-opened',
      to: msg.from,
      req,
      hwnd: r.hwnd,
      title: r.title,
      created: isNew || !!r.created,
      envOk: isNew ? !!r.envOk : true,
    });
  } else {
    const code = (r && r.code) || 'failed';
    log(`${isNew ? '新建' : '打开'}会话失败: ${code}`);
    send({ type: 'session-failed', to: msg.from, req, code });
  }
}

/** 已经因为"控制端关了窗口"通知过 window-closed 的画面，采集随后停了也不再通知一次 */
const reportedClosed = new WeakSet();

/**
 * 控制端要关掉一个会话窗口（协议文档 2.8）：回 close-window-result，成功时再给它新的窗口列表。
 * 别的控制端正在看这个窗口的，通知它们 window-closed：Claude 只是把窗口藏起来，采集不一定会自己停。
 */
async function closeWindow(msg) {
  const req = typeof msg.req === 'string' ? msg.req.slice(0, 40) : '';
  const hwnd = Number(msg.hwnd);
  const title = typeof msg.title === 'string' ? msg.title : null;
  log(`控制端 ${msg.from} 要关闭窗口「${title || hwnd}」`);
  const r = (await bridge.closeWindow(hwnd, title)) || { ok: false, code: 'failed' };
  if (r.ok) {
    log(`窗口「${r.title}」已关闭`);
    for (const [id, p] of peers) {
      if (id === msg.from || p.hwnd !== hwnd) continue;
      if (p.stream) reportedClosed.add(p.stream);
      send({ type: 'window-closed', to: id });
    }
  } else {
    log(`关闭窗口没有成功: ${r.code}`);
  }
  const reply = { type: 'close-window-result', to: msg.from, req, hwnd, ok: !!r.ok };
  if (!r.ok) reply.code = r.code || 'failed';
  send(reply);
  // 关掉了、本来就没了、句柄换了别的会话：列表都变了，直接给新的
  if (r.ok || r.code === 'gone' || r.code === 'changed') send({ type: 'windows', to: msg.from, list: await bridge.listWindows() });
}

function lockNow(viewerId) {
  log(`控制端 ${viewerId} 锁定了电脑`);
  bridge.lockNow();
}

function unlock(viewerId, peer, ev) {
  const id = typeof ev.id === 'string' && IMAGE_ID.test(ev.id) ? ev.id : null;
  const password = typeof ev.p === 'string' ? ev.p : '';
  ev.p = null; // 密码只交给主进程，不留在这里
  if (!id) return;
  if (!password) return sendToViewer(peer, { t: 'unlock-result', id, ok: false, code: 'failed' });
  log(`控制端 ${viewerId} 请求解锁`);
  bridge.unlock(password).then((code) => {
    log(code ? `解锁没有成功: ${code}` : '已从控制端解锁');
    sendToViewer(peer, code ? { t: 'unlock-result', id, ok: false, code } : { t: 'unlock-result', id, ok: true });
  });
}

// 主进程拒绝了某次输入（窗口切不到前台、被挡住、已关闭），告诉对应的控制端。
// detail 是被控端写好的补充说明（比如挡在最前面的是谁），控制端接在提示后面
bridge.onInputError((viewerId, code, detail) => {
  const p = peers.get(viewerId);
  if (p && p.dc && p.dc.readyState === 'open') p.dc.send(JSON.stringify(detail ? { t: 'err', code, detail } : { t: 'err', code }));
});

// ---------------------------------------------------------------- 登录与界面切换

const SERVER_HINT = $('serverHint').textContent;

/** 页面上显示的服务器地址跟着主进程的设置走（启动时、换了服务器后） */
function showServer() {
  $('server').textContent = `${cfg.serverDisplay || '未设置服务器'} · 可远控进程: ${cfg.targets.join(', ')}`;
  $('serverName').textContent = cfg.serverDisplay || '未设置';
  $('serverInput').value = cfg.serverInput || '';
  const missing = !cfg.server;
  $('serverHint').textContent = missing ? `还没有设置服务器地址。${SERVER_HINT}` : SERVER_HINT;
  $('serverHint').classList.toggle('warn', missing);
}

function showLogin(message) {
  disconnect();
  setStatus('off', cfg && cfg.server ? '未登录，请在窗口里登录' : '未设置服务器，请在窗口里填写服务器地址');
  $('mainView').hidden = true;
  $('loginView').hidden = false;
  $('loginError').hidden = !message;
  $('loginError').textContent = message || '';
  $('password').value = '';
  (cfg && cfg.server ? $('email') : $('serverInput')).focus();
}

function showMain(acct) {
  $('loginView').hidden = true;
  $('mainView').hidden = false;
  $('serverForm').hidden = true;
  $('accountEmail').textContent = acct.email || '';
  $('deviceName').textContent = acct.deviceName || '';
  $('reconnect').hidden = true;
  renderViewers();
  stopped = false;
  backoff = 1000;
  connect();
}

/**
 * 把填的地址交给主进程（它负责整理、检查、写进配置文件，换了服务器时退出旧服务器上的登录）。
 * 返回 { server, changed } 或 { error }；换成功后刷新页面上用到的配置
 */
async function applyServer(input) {
  const res = (await bridge.setServer(input)) || { error: '参数不对' };
  if (res.error) return res;
  cfg = await bridge.getConfig();
  showServer();
  if (res.changed) log(`服务器地址改为 ${res.server}`);
  return res;
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true;
  btn.textContent = '正在登录…';
  $('loginError').hidden = true;
  try {
    const srv = await applyServer($('serverInput').value);
    if (srv.error) {
      $('loginError').textContent = srv.error;
      $('loginError').hidden = false;
      $('serverInput').focus();
      return;
    }
    const res = await bridge.login($('email').value, $('password').value);
    if (res && res.error) {
      $('loginError').textContent = res.error;
      $('loginError').hidden = false;
      return;
    }
    log(`已登录 ${res.email}`);
    showMain(await bridge.getAccount());
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
});

/** 注册和找回密码在服务器的网页上，先按地址框里填的服务器设置好再打开 */
async function openAccountPage(which) {
  $('loginError').hidden = true;
  const srv = await applyServer($('serverInput').value);
  if (srv.error) {
    $('loginError').textContent = srv.error;
    $('loginError').hidden = false;
    $('serverInput').focus();
    return;
  }
  bridge.openAccountPage(which);
}

$('toRegister').addEventListener('click', (e) => {
  e.preventDefault();
  openAccountPage('register');
});
$('toForgot').addEventListener('click', (e) => {
  e.preventDefault();
  openAccountPage('forgot');
});

// ---------------------------------------------------------------- 更换服务器（登录后）

function openServerForm() {
  if ($('mainView').hidden) {
    // 还没登录：登录页上就有地址框
    $('serverInput').focus();
    $('serverInput').select();
    return;
  }
  $('serverForm').hidden = false;
  $('serverError').hidden = true;
  $('newServer').value = cfg.serverDisplay || '';
  $('newServer').focus();
  $('newServer').select();
}

$('changeServer').addEventListener('click', openServerForm);
$('cancelServer').addEventListener('click', () => {
  $('serverForm').hidden = true;
});
bridge.onEditServer(openServerForm);

$('serverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('serverForm').querySelector('button[type="submit"]');
  btn.disabled = true;
  $('serverError').hidden = true;
  // 先断开旧服务器，免得主进程作废旧令牌时页面又收到"登录已失效"去重连
  const wasRunning = !stopped;
  disconnect();
  try {
    const res = await applyServer($('newServer').value);
    if (res.error || !res.changed) {
      if (wasRunning) {
        stopped = false;
        backoff = 1000;
        connect();
      }
      if (res.error) {
        $('serverError').textContent = res.error;
        $('serverError').hidden = false;
        $('newServer').focus();
      } else {
        $('serverForm').hidden = true;
      }
      return;
    }
    $('serverForm').hidden = true;
    log('已退出旧服务器上的登录');
    showLogin(`已换到 ${res.server}，请用这个服务器上的账号登录`);
    $('email').focus();
  } finally {
    btn.disabled = false;
  }
});

$('logout').addEventListener('click', async () => {
  disconnect();
  await bridge.logout();
  log('已退出登录');
  showLogin('');
});

$('reconnect').addEventListener('click', () => {
  $('reconnect').hidden = true;
  stopped = false;
  backoff = 1000;
  connect();
});

(async () => {
  cfg = await bridge.getConfig();
  const acct = await bridge.getAccount();
  showServer();
  if (acct.loggedIn && cfg.server) showMain(acct);
  else showLogin(cfg.serverNotice || '');
})();
