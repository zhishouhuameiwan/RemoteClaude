package com.remoteclaude.android.rtc

import android.os.Handler
import android.os.Looper
import com.remoteclaude.android.protocol.ClipAssembler
import com.remoteclaude.android.protocol.FileReply
import com.remoteclaude.android.protocol.IceCandidateSpec
import com.remoteclaude.android.protocol.IceServerSpec
import com.remoteclaude.android.protocol.ImageReply
import com.remoteclaude.android.protocol.InputError
import com.remoteclaude.android.protocol.LockState
import com.remoteclaude.android.protocol.TileState
import com.remoteclaude.android.protocol.UnlockResult
import com.remoteclaude.android.protocol.Protocol
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RTCStatsReport
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import java.nio.ByteBuffer

/**
 * 与被控端之间的一条 WebRTC 连接。被控端发 offer，这里只做应答方（协议文档第 2 节）。
 *
 * WebRTC 的回调发生在它自己的信令线程上，这里统一转到主线程再交给 [Callbacks]，
 * 连接关闭后的迟到回调直接丢弃。除构造外，所有方法都应在主线程调用。
 */
class PeerSession(
    engine: RtcEngine,
    iceServers: List<IceServerSpec>,
    private val callbacks: Callbacks,
) {
    interface Callbacks {
        fun onLocalIce(session: PeerSession, candidate: IceCandidateSpec)
        fun onVideoTrack(session: PeerSession, track: VideoTrack)
        fun onConnectionState(session: PeerSession, state: PeerConnection.PeerConnectionState)
        fun onInputError(session: PeerSession, error: InputError)
        fun onImageReply(session: PeerSession, reply: ImageReply)
        fun onLockState(session: PeerSession, state: LockState)
        fun onUnlockResult(session: PeerSession, result: UnlockResult)
        fun onTileState(session: PeerSession, state: TileState)
        /** 电脑能收文件，[max] 是大小上限（协议文档 4.8） */
        fun onFileCaps(session: PeerSession, max: Long)
        fun onFileReply(session: PeerSession, reply: FileReply)
        /** 电脑上新复制了一段文字，已经拼完整（协议文档 4.9） */
        fun onClipboardText(session: PeerSession, text: String)
        /** 电脑上复制了文字但没有发过来，[code] 是原因（协议文档 4.9） */
        fun onClipboardSkipped(session: PeerSession, code: String)
    }

    private val main = Handler(Looper.getMainLooper())
    private var input: DataChannel? = null
    /** 传文件的通道，第一次发文件时由这边建（协议文档 4.8） */
    private var file: DataChannel? = null
    /** 拼电脑分块发来的剪贴板文字，只在收数据通道消息的线程上用 */
    private val clipAssembler = ClipAssembler()
    private val pendingIce = ArrayList<IceCandidate>()
    private var remoteDescriptionSet = false
    private var closed = false

    var connectionState: PeerConnection.PeerConnectionState = PeerConnection.PeerConnectionState.NEW
        private set

    val inputOpen: Boolean get() = input?.state() == DataChannel.State.OPEN

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
        override fun onIceConnectionReceivingChange(receiving: Boolean) {}
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
        override fun onAddStream(stream: MediaStream?) {}
        override fun onRemoveStream(stream: MediaStream?) {}
        override fun onRenegotiationNeeded() {}

        override fun onIceCandidate(candidate: IceCandidate) {
            val spec = IceCandidateSpec(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex)
            onMain { callbacks.onLocalIce(this@PeerSession, spec) }
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            val track = transceiver.receiver.track() as? VideoTrack ?: return
            onMain { callbacks.onVideoTrack(this@PeerSession, track) }
        }

        override fun onDataChannel(channel: DataChannel) {
            // 数据通道由被控端创建，标签是 input（协议文档第 2 节）。立即注册，免得漏掉早到的消息
            if (channel.label() != INPUT_LABEL) return
            channel.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) {}
                override fun onStateChange() {}
                override fun onMessage(buffer: DataChannel.Buffer) {
                    if (buffer.binary) return
                    val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                    val text = String(bytes, Charsets.UTF_8)
                    // 剪贴板文字是这条通道上最大的消息，先认它，免得下面每种解析都把它过一遍
                    Protocol.parseClipChunk(text)?.let { chunk ->
                        val whole = clipAssembler.add(chunk) ?: return
                        onMain { callbacks.onClipboardText(this@PeerSession, whole) }
                        return
                    }
                    Protocol.parseClipSkip(text)?.let { code ->
                        onMain { callbacks.onClipboardSkipped(this@PeerSession, code) }
                        return
                    }
                    Protocol.parseLockState(text)?.let { state ->
                        onMain { callbacks.onLockState(this@PeerSession, state) }
                        return
                    }
                    Protocol.parseTileState(text)?.let { state ->
                        onMain { callbacks.onTileState(this@PeerSession, state) }
                        return
                    }
                    Protocol.parseUnlockResult(text)?.let { result ->
                        onMain { callbacks.onUnlockResult(this@PeerSession, result) }
                        return
                    }
                    Protocol.parseImageReply(text)?.let { reply ->
                        onMain { callbacks.onImageReply(this@PeerSession, reply) }
                        return
                    }
                    Protocol.parseFileCaps(text)?.let { max ->
                        onMain { callbacks.onFileCaps(this@PeerSession, max) }
                        return
                    }
                    val error = Protocol.parseInputError(text) ?: return
                    onMain { callbacks.onInputError(this@PeerSession, error) }
                }
            })
            onMain { input = channel }
        }

        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            onMain {
                connectionState = newState
                callbacks.onConnectionState(this@PeerSession, newState)
            }
        }
    }

    private val pc: PeerConnection

    init {
        val servers = iceServers.map { spec ->
            PeerConnection.IceServer.builder(spec.urls).apply {
                spec.username?.let { setUsername(it) }
                spec.credential?.let { setPassword(it) }
            }.createIceServer()
        }
        val config = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        pc = engine.factory.createPeerConnection(config, observer)
            ?: throw IllegalStateException("无法创建 PeerConnection")
    }

    /** 设置被控端的 offer，生成并设置应答，成功后把应答 SDP 交给 [onAnswer] */
    fun acceptOffer(sdp: String, onAnswer: (String) -> Unit, onError: (String) -> Unit) {
        pc.setRemoteDescription(object : SdpObserverAdapter() {
            override fun onSetSuccess() = onMain {
                remoteDescriptionSet = true
                // 对端描述设好之前收到的 ICE 候选，现在补上（协议文档第 2 节）
                pendingIce.forEach { pc.addIceCandidate(it) }
                pendingIce.clear()
                createAnswer(onAnswer, onError)
            }

            override fun onSetFailure(error: String?) = onMain { onError("设置远端描述失败: $error") }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    private fun createAnswer(onAnswer: (String) -> Unit, onError: (String) -> Unit) {
        pc.createAnswer(object : SdpObserverAdapter() {
            override fun onCreateSuccess(desc: SessionDescription) = onMain {
                pc.setLocalDescription(object : SdpObserverAdapter() {
                    override fun onSetSuccess() = onMain { onAnswer(desc.description) }
                    override fun onSetFailure(error: String?) = onMain { onError("设置本地描述失败: $error") }
                }, desc)
            }

            override fun onCreateFailure(error: String?) = onMain { onError("生成应答失败: $error") }
        }, MediaConstraints())
    }

    fun addRemoteIce(spec: IceCandidateSpec) {
        if (closed || spec.candidate.isBlank()) return
        val candidate = IceCandidate(spec.sdpMid ?: "0", spec.sdpMLineIndex, spec.candidate)
        if (remoteDescriptionSet) pc.addIceCandidate(candidate) else pendingIce += candidate
    }

    /** 通过数据通道发一条文本消息。必须是文本帧：被控端按字符串解析，二进制帧会被丢弃 */
    fun sendInput(text: String): Boolean {
        val channel = input ?: return false
        if (channel.state() != DataChannel.State.OPEN) return false
        return channel.send(DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false))
    }

    /** 通过数据通道发一段二进制数据（图片分块，协议文档 4.5） */
    fun sendBinary(bytes: ByteArray, offset: Int, length: Int): Boolean {
        val channel = input ?: return false
        if (channel.state() != DataChannel.State.OPEN) return false
        return channel.send(DataChannel.Buffer(ByteBuffer.wrap(bytes, offset, length), true))
    }

    /** 数据通道里排队还没发出去的字节数。传图时据此控制节奏，排队超过 16 MB 通道会被关闭 */
    fun bufferedAmount(): Long = input?.takeIf { it.state() == DataChannel.State.OPEN }?.bufferedAmount() ?: 0L

    /**
     * 传文件的通道（标签 file，有序可靠）。和输入通道分开，传大文件时点击、打字不用排在文件后面。
     * 第一次调用时建，之后返回同一条；建好后要等它 [fileOpen] 才能发。
     */
    fun openFileChannel(): Boolean {
        if (closed) return false
        if (file != null) return true
        val channel = pc.createDataChannel(FILE_LABEL, DataChannel.Init().apply { ordered = true }) ?: return false
        channel.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {}
            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary) return
                val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                val reply = Protocol.parseFileReply(String(bytes, Charsets.UTF_8)) ?: return
                onMain { callbacks.onFileReply(this@PeerSession, reply) }
            }
        })
        file = channel
        return true
    }

    val fileOpen: Boolean get() = file?.state() == DataChannel.State.OPEN

    /** file 通道已经关了（或建不起来），这条连接上发不了文件了 */
    val fileClosed: Boolean get() = file?.state().let { it == DataChannel.State.CLOSING || it == DataChannel.State.CLOSED }

    fun sendFileText(text: String): Boolean {
        val channel = file?.takeIf { it.state() == DataChannel.State.OPEN } ?: return false
        return channel.send(DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false))
    }

    /** 发一段文件字节。原生层会先复制一份，[bytes] 发完就可以复用 */
    fun sendFileBinary(bytes: ByteArray, offset: Int, length: Int): Boolean {
        val channel = file?.takeIf { it.state() == DataChannel.State.OPEN } ?: return false
        return channel.send(DataChannel.Buffer(ByteBuffer.wrap(bytes, offset, length), true))
    }

    fun fileBufferedAmount(): Long = file?.takeIf { it.state() == DataChannel.State.OPEN }?.bufferedAmount() ?: 0L

    fun getStats(callback: (RTCStatsReport) -> Unit) {
        if (closed) return
        pc.getStats { report -> onMain { callback(report) } }
    }

    /** 关闭连接并释放原生资源。调用前要先把渲染器从视频轨道上摘下来，轨道会随连接一起释放 */
    fun close() {
        if (closed) return
        closed = true
        input?.let {
            it.unregisterObserver()
            it.dispose()
        }
        input = null
        file?.let {
            it.unregisterObserver()
            it.dispose()
        }
        file = null
        pc.dispose()
    }

    private fun onMain(block: () -> Unit) {
        main.post { if (!closed) block() }
    }

    private open class SdpObserverAdapter : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetFailure(error: String?) {}
    }

    private companion object {
        const val INPUT_LABEL = "input"
        const val FILE_LABEL = "file"
    }
}
