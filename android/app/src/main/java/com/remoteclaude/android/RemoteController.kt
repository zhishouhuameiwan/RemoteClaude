package com.remoteclaude.android

import android.app.Application
import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import com.remoteclaude.android.data.AppSettings
import com.remoteclaude.android.data.SettingsStore
import com.remoteclaude.android.files.FileSource
import com.remoteclaude.android.files.FileUploads
import com.remoteclaude.android.files.StallWatch
import com.remoteclaude.android.image.ImagePrep
import com.remoteclaude.android.input.FontZoom
import com.remoteclaude.android.input.InputSender
import com.remoteclaude.android.input.RemotePoint
import com.remoteclaude.android.net.ApiResult
import com.remoteclaude.android.net.AuthApi
import com.remoteclaude.android.net.SignalingClient
import com.remoteclaude.android.protocol.FileReply
import com.remoteclaude.android.protocol.HostInfo
import com.remoteclaude.android.protocol.HostState
import com.remoteclaude.android.protocol.IceCandidateSpec
import com.remoteclaude.android.protocol.IceServerSpec
import com.remoteclaude.android.protocol.ImageReply
import com.remoteclaude.android.protocol.InputError
import com.remoteclaude.android.protocol.LockState
import com.remoteclaude.android.protocol.TileState
import com.remoteclaude.android.protocol.UnlockCipher
import com.remoteclaude.android.protocol.UnlockResult
import com.remoteclaude.android.protocol.Incoming
import com.remoteclaude.android.protocol.InputEvents
import com.remoteclaude.android.protocol.Protocol
import com.remoteclaude.android.protocol.RemoteWindow
import com.remoteclaude.android.protocol.SessionEntry
import com.remoteclaude.android.protocol.AppUpdateInfo
import com.remoteclaude.android.protocol.HostUpdateState
import com.remoteclaude.android.update.AppUpdater
import com.remoteclaude.android.approvals.ApprovalNotifier
import com.remoteclaude.android.approvals.ApprovalService
import com.remoteclaude.android.approvals.PendingApproval
import com.remoteclaude.android.protocol.Approval
import com.remoteclaude.android.protocol.SessionGroup
import com.remoteclaude.android.protocol.ServerAddress
import com.remoteclaude.android.rtc.FirstFrameProbe
import com.remoteclaude.android.rtc.PeerSession
import com.remoteclaude.android.rtc.RtcEngine
import com.remoteclaude.android.rtc.StatsReader
import com.remoteclaude.android.rtc.StreamStats
import com.remoteclaude.android.video.RemoteStageView
import com.remoteclaude.android.windows.HostCommands
import com.remoteclaude.android.windows.WindowClose
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.webrtc.PeerConnection
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import java.security.MessageDigest

enum class Screen { Loading, Auth, Sessions, Remote }

/** 账号页的三种模式 */
enum class AuthMode { Login, Register, Forgot }

/** 与信令服务器的连接状态 */
enum class Link { Offline, Connecting, Online }

/** 画面连接（WebRTC）的状态 */
enum class RtcPhase { None, Connecting, Connected, Failed }

/**
 * "已打开"页签里的一个窗口；[closable] 为 null 表示电脑上的被控端是旧版本，不能从手机关（协议文档 2.8）。
 * [thumbLoading]：列表先到了，缩略图电脑还在截（协议文档 2.4），[thumb] 是上一次的图，没有就先空着
 */
data class WindowItem(
    val hwnd: Long,
    val title: String,
    val minimized: Boolean,
    val thumb: ImageBitmap?,
    val closable: Boolean? = null,
    val thumbLoading: Boolean = false,
)

data class CurrentWindow(val hwnd: Long, val title: String)

/** 会话列表页的两个页签：电脑上已打开的窗口，和 Claude 桌面端的全部会话（协议文档 2.5） */
enum class ListTab { Open, All }

/** 全部会话的加载情况：[NoReply] 是电脑没回话（被控端版本太旧），[Unavailable] 是电脑上没有 Claude 桌面端的会话记录 */
enum class CatalogPhase { None, Loaded, Unavailable, NoReply }

/** 正在电脑上打开或新建会话，等它回话；[req] 用来认回执 */
data class OpeningSession(val req: String, val label: String)

/**
 * 正在发的图片或文件：[preparing] 表示还在手机上处理（压缩图片、读文件），[pasting] 表示已经传完、等电脑存好并粘贴。
 * [fileName] 不为 null 表示发的是文件（协议文档 4.8），可以取消
 */
data class UploadProgress(
    val sent: Long = 0,
    val total: Long = 0,
    val preparing: Boolean = false,
    val pasting: Boolean = false,
    val fileName: String? = null,
)

data class AppState(
    val screen: Screen = Screen.Loading,
    val serverInput: String = "",
    val email: String = "",
    // 账号页
    val authMode: AuthMode = AuthMode.Login,
    val authBusy: Boolean = false,
    val codeSending: Boolean = false,
    val authError: String? = null,
    val authInfo: String? = null,
    /** 验证码冷却结束的时刻（SystemClock.elapsedRealtime） */
    val codeCooldownUntil: Long = 0L,
    // 连接与画面
    val link: Link = Link.Offline,
    val hosts: List<HostInfo> = emptyList(),
    /** 当前选中的电脑 */
    val hostId: String? = null,
    val windows: List<WindowItem> = emptyList(),
    val windowsLoaded: Boolean = false,
    val refreshing: Boolean = false,
    val current: CurrentWindow? = null,
    val listTab: ListTab = ListTab.Open,
    val catalog: List<SessionGroup> = emptyList(),
    val catalogPhase: CatalogPhase = CatalogPhase.None,
    val catalogRefreshing: Boolean = false,
    val opening: OpeningSession? = null,
    /** 正在电脑上关掉、等回执的窗口（协议文档 2.8） */
    val closingWindows: Set<Long> = emptySet(),
    /** 点了关闭，但电脑上的被控端是旧版本，弹说明 */
    val closeUnsupported: Boolean = false,
    /** 服务器上有比本 App 新的安装包（docs/08） */
    val appUpdate: AppUpdateInfo? = null,
    /** 正在下载新安装包的进度（0 到 100），没在下载时为 null */
    val appUpdateProgress: Int? = null,
    /** 新安装包已经下好、校验过，只等安装（要先在系统设置里允许本 App 安装应用） */
    val appUpdateReady: Boolean = false,
    /** 当前这台电脑的被控端版本和升级状态（协议文档 2.6），问过才有 */
    val hostUpdate: HostUpdateState? = null,
    /** 账号下各台电脑上等手机作答的审批和提问（docs/09），按出现时间排 */
    val approvals: List<PendingApproval> = emptyList(),
    /** 审批面板开着 */
    val showApprovals: Boolean = false,
    /** 已经提交、等电脑回执的审批 */
    val answering: Set<String> = emptySet(),
    val rtc: RtcPhase = RtcPhase.None,
    val hasVideo: Boolean = false,
    val upload: UploadProgress? = null,
    /** 电脑能收文件时是单个文件的大小上限（被控端 0.9.0 起，协议文档 4.8），只在连着画面时知道 */
    val fileMax: Long? = null,
    /**
     * 当前这台电脑的被控端认不连画面的命令（协议文档 2.9，被控端 0.9.6 起）：停在会话列表也知道下面的锁屏、平铺状态，
     * 也能重排窗口、锁定、解锁。旧版被控端只有连着画面时才知道、才能操作
     */
    val hostCommands: Boolean = false,
    /**
     * 当前这台电脑回了窗口列表、却没推过它的状态：被控端是 0.9.6 以前的版本，会话列表页提示升级。
     * （状态在控制端一连上时就推，总比窗口列表先到；只看"还没收到状态"会在刚重连的那一下误报）
     */
    val hostTooOld: Boolean = false,
    /** 电脑锁屏了（协议文档 4.6） */
    val pcLocked: Boolean = false,
    /** 电脑上装了解锁服务，可以从手机解锁 */
    val unlockAvailable: Boolean = false,
    /** 电脑上的解锁服务核实不过（多半是旧版，要在电脑上重新安装），和"没装"分开提示 */
    val unlockUntrusted: Boolean = false,
    val unlocking: Boolean = false,
    /** 电脑上的窗口平铺在运行（协议文档 4.7） */
    val tileAvailable: Boolean = false,
    val tilePaused: Boolean = false,
    /** "全部会话"里折叠起来的环境（组的 key），记在本机 */
    val collapsedGroups: Set<String> = emptySet(),
    val settings: AppSettings = AppSettings(),
    val locked: Boolean = false,
    /** 设备设置了锁屏，才能启用"打开时验证身份" */
    val canLock: Boolean = false,
) {
    val currentHost: HostInfo? get() = hosts.firstOrNull { it.id == hostId }
    val hostOnline: Boolean get() = currentHost?.online == true

    /** 换成这台电脑的锁屏、平铺状态；[hs] 为 null 表示不知道（电脑不在线，或者是旧版被控端又没连画面） */
    fun withHostState(hs: HostState?): AppState = copy(
        hostCommands = hs != null,
        hostTooOld = false,
        pcLocked = hs?.lock?.locked == true,
        unlockAvailable = hs?.lock?.unlockAvailable == true,
        unlockUntrusted = hs?.lock?.unlockUntrusted == true,
        tileAvailable = hs?.tile?.available == true,
        tilePaused = hs?.tile?.paused == true,
    )
}

/**
 * 整个控制端的状态机：账号、信令连接、电脑与窗口列表、画面连接、输入、前后台切换。
 * 进程内只有一个，挂在 Application 上，屏幕旋转不受影响。只在主线程使用。
 *
 * 行为约定见 docs/04-android-client.md 的"生命周期与网络"一节，协议见 docs/03-protocol.md。
 */
class RemoteController(private val app: Application) {
    private val scope = MainScope()
    private val store = SettingsStore(app)
    private val api = AuthApi()

    /** 第一次用到时才加载 WebRTC 原生库 */
    val rtc: RtcEngine by lazy { RtcEngine(app) }

    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state.asStateFlow()

    /** 给用户看的短提示 */
    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 16)
    val messages: SharedFlow<String> = _messages.asSharedFlow()

    private val _stats = MutableStateFlow<StreamStats?>(null)
    val stats: StateFlow<StreamStats?> = _stats.asStateFlow()

    private val signaling = SignalingClient(object : SignalingClient.Listener {
        override fun onOpen() = sendAuth()
        override fun onMessage(msg: Incoming) = handle(msg)
        override fun onClosed() = onSocketClosed()
    })

    val input = InputSender { text -> peer?.sendInput(text) == true }

    private var loaded = false
    private var foreground = false
    private var wsUrl: String? = null
    private var httpBase: String? = null
    /** 登录令牌；为 null 表示没登录 */
    private var session: String? = null
    private var deviceId = ""
    private var authed = false
    private var iceServers: List<IceServerSpec> = emptyList()
    private var backoffMs = INITIAL_BACKOFF_MS
    private var retryJob: Job? = null
    private var refreshJob: Job? = null
    private var catalogJob: Job? = null
    private val updater by lazy { AppUpdater(app) }
    private var updateJob: Job? = null
    /** 下好的新安装包和它的 versionCode */
    private var downloadedApk: Pair<Int, java.io.File>? = null
    /** 上次自动检查 App 更新的时刻（SystemClock.elapsedRealtime），0 表示还没查过 */
    private var lastUpdateCheck = 0L
    /** 各台电脑推来的审批列表 */
    private val approvalsByHost = LinkedHashMap<String, List<Approval>>()
    private var approvalSeq = 0
    private val loadedSignal = CompletableDeferred<Unit>()
    private var openJob: Job? = null
    private var openSeq = 0
    /** 发出去、还没收到回执的关闭窗口请求：req -> 窗口 */
    private val closeRequests = HashMap<String, WindowItem>()
    private var closeSeq = 0

    private var peer: PeerSession? = null
    /** 当前画面连接来自哪台电脑 */
    private var peerHost: String? = null
    private var videoTrack: VideoTrack? = null
    private var renderer: VideoSink? = null
    private var frameProbe: VideoSink? = null
    /** 想看的窗口：断线重连、回到前台、电脑重新上线后自动选回它；为 0 表示停在会话列表 */
    private var wantHwnd = 0L
    private var reselectJob: Job? = null
    private var statsJob: Job? = null
    private val statsReader = StatsReader()

    private var backgroundSince = 0L
    /** 正在显示系统的身份验证界面。这期间应用会短暂进入后台，不能因此断线或再次上锁 */
    var authenticating = false
    /** 正在系统的选图、选文件界面里。和身份验证一样不断线，但最多等 [PICK_GRACE_MS] */
    private var picking = false
    private var pickGuardJob: Job? = null
    /** 正在发的图片或文件，同一时间只发一个 */
    private var uploadJob: Job? = null
    /** 图片 id -> 等它的回执；回执的错误码，成功时是 [IMAGE_OK] */
    private val imageWaiters = HashMap<String, CompletableDeferred<String>>()
    /** 文件 id -> 等它的回执（协议文档 4.8） */
    private val fileWaiters = HashMap<String, CompletableDeferred<FileReply>>()

    /** 路径没能粘贴进电脑上的输入框时，放进手机上的输入框，用户接着写要说的话再点"发送" */
    private val _inputFill = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val inputFill: SharedFlow<String> = _inputFill.asSharedFlow()
    /** 解锁请求 id -> 等它的回执，格式同 [imageWaiters] */
    private val unlockWaiters = HashMap<String, CompletableDeferred<String>>()
    /** 各台电脑经信令通道推来的状态（协议文档 2.9）；有记录说明那台电脑的被控端认不连画面的命令 */
    private val hostStates = HashMap<String, HostState>()
    /** 不连画面的解锁请求 req -> 等它的回执，格式同 [imageWaiters] */
    private val hostCmdWaiters = HashMap<String, CompletableDeferred<String>>()
    private var hostCmdSeq = 0

    private val hostId: String? get() = _state.value.hostId

    init {
        scope.launch {
            val stored = store.load()
            // App 里不带服务器地址，只用手机上存的（登录成功时存下的那个，见 ServerAddress.restore）
            val server = stored.server
            val parsed = ServerAddress.restore(server, BuildConfig.ALLOW_CLEARTEXT)
            wsUrl = parsed?.url
            httpBase = parsed?.httpBase
            session = stored.session
            deviceId = stored.deviceId
            wantHwnd = stored.lastHwnd
            loaded = true
            val canLock = deviceCanLock()
            val loggedIn = session != null && wsUrl != null
            update {
                it.copy(
                    screen = if (loggedIn) Screen.Sessions else Screen.Auth,
                    serverInput = server,
                    // 登录过、却没存下能用的服务器地址：说明一下为什么又回到了登录页
                    authError = if (session != null && wsUrl == null) "请填写服务器地址后重新登录" else null,
                    email = stored.email,
                    hostId = stored.lastHost.ifEmpty { null },
                    settings = stored.settings,
                    collapsedGroups = stored.collapsedGroups,
                    canLock = canLock,
                    locked = loggedIn && canLock && stored.settings.appLock,
                )
            }
            loadedSignal.complete(Unit)
            syncBackgroundService()
            connectIfLoggedIn()
        }
    }

    // ------------------------------------------------------------------ 前后台与网络

    /** 后台也保持和服务器的连接：登录了、设置里开着"后台接收审批"（docs/09 第 6 节） */
    private val keepAlive: Boolean get() = session != null && _state.value.settings.backgroundApprovals

    private val wantConnection: Boolean get() = foreground || keepAlive

    suspend fun awaitLoaded() = loadedSignal.await()

    /** 按设置开关后台接收审批的前台服务；从后台启动不了时（安卓 12 起）等下次 App 打开再启动 */
    fun syncBackgroundService() {
        if (!loaded) return
        if (keepAlive) ApprovalService.start(app) else ApprovalService.stop(app)
    }

    fun onForeground() {
        foreground = true
        pickGuardJob?.cancel()
        if (!loaded) return
        val canLock = deviceCanLock()
        val s = _state.value
        val relock = !authenticating && !picking && s.settings.appLock && canLock && session != null &&
            backgroundSince > 0 && SystemClock.elapsedRealtime() - backgroundSince > LOCK_AFTER_MS
        update { it.copy(canLock = canLock, locked = it.locked || relock) }
        syncBackgroundService()
        connectIfLoggedIn()
        // 开着后台接收审批时信令连接没断、只断了画面，connectIfLoggedIn 什么都不做：要一次窗口列表，自动选回刚才看的窗口
        if (authed && peer == null && wantHwnd != 0L) requestList()
        publishApprovals()
    }

    /** 切到后台就停止看画面；开着"后台接收审批"时保持和服务器的连接，否则也断开，回来再重连 */
    fun onBackground() {
        foreground = false
        backgroundSince = SystemClock.elapsedRealtime()
        if (authenticating) return
        if (picking || fileUploading) {
            // 选图、选文件时画面连接留着，选完马上能发；正在发文件时也留着，等它发完。
            // 都有时限：用户可能从选择界面直接回了桌面，不能一直连着
            pickGuardJob = scope.launch {
                val start = SystemClock.elapsedRealtime()
                while (!foreground) {
                    val elapsed = SystemClock.elapsedRealtime() - start
                    if (fileUploading) {
                        if (elapsed > UPLOAD_GRACE_MS) break
                    } else if (!picking || elapsed > PICK_GRACE_MS) {
                        break
                    }
                    delay(1000)
                }
                if (foreground) return@launch
                picking = false
                stopStreaming(sendStop = true)
                if (!keepAlive) disconnect()
            }
            return
        }
        stopStreaming(sendStop = true)
        if (!keepAlive) disconnect()
        publishApprovals()
    }

    /** Wi-Fi 与移动网络之间切换后，旧连接多半已经不通，立即重连而不是等心跳超时 */
    fun onNetworkChanged() {
        if (!wantConnection || session == null || (_state.value.locked && !keepAlive)) return
        Log.i(TAG, "网络已切换，立即重连")
        backoffMs = INITIAL_BACKOFF_MS
        stopStreaming(sendStop = false)
        openSocket()
    }

    fun deviceCanLock(): Boolean =
        BiometricManager.from(app).canAuthenticate(BIOMETRIC_WEAK or DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS

    fun onUnlocked() {
        authenticating = false
        update { it.copy(locked = false) }
        connectIfLoggedIn()
    }

    // ------------------------------------------------------------------ 账号：登录、注册、找回密码

    fun setAuthMode(mode: AuthMode) {
        update { it.copy(authMode = mode, authError = null, authInfo = null) }
    }

    /** 检查服务器地址，返回账号接口的根地址；不合法时在账号页显示原因 */
    private fun resolveServer(serverInput: String): ServerAddress.Result.Ok? =
        when (val r = ServerAddress.parse(serverInput.trim(), BuildConfig.ALLOW_CLEARTEXT)) {
            is ServerAddress.Result.Ok -> r
            is ServerAddress.Result.Invalid -> {
                update { it.copy(authError = r.reason, authInfo = null) }
                null
            }
        }

    private val device: AuthApi.DeviceInfo
        get() = AuthApi.DeviceInfo(deviceId, deviceName())

    fun login(serverInput: String, email: String, password: String) {
        val server = resolveServer(serverInput) ?: return
        if (email.isBlank() || password.isEmpty()) {
            update { it.copy(authError = "请填写邮箱和密码") }
            return
        }
        runAuth {
            when (val r = api.login(server.httpBase, email.trim(), password, device)) {
                is ApiResult.Ok -> signedIn(serverInput.trim(), server, r.value.token, r.value.email)
                is ApiResult.Err -> update { it.copy(authError = r.message) }
            }
        }
    }

    fun register(serverInput: String, email: String, code: String, password: String) {
        val server = resolveServer(serverInput) ?: return
        if (!checkCodeForm(email, code, password)) return
        runAuth {
            when (val r = api.register(server.httpBase, email.trim(), code.trim(), password, device)) {
                is ApiResult.Ok -> signedIn(serverInput.trim(), server, r.value.token, r.value.email)
                is ApiResult.Err -> update { it.copy(authError = r.message) }
            }
        }
    }

    fun resetPassword(serverInput: String, email: String, code: String, password: String) {
        val server = resolveServer(serverInput) ?: return
        if (!checkCodeForm(email, code, password)) return
        runAuth {
            when (val r = api.resetPassword(server.httpBase, email.trim(), code.trim(), password)) {
                is ApiResult.Ok -> update {
                    it.copy(authMode = AuthMode.Login, authError = null, authInfo = "密码已重置，请用新密码登录")
                }
                is ApiResult.Err -> update { it.copy(authError = r.message) }
            }
        }
    }

    fun sendCode(serverInput: String, email: String) {
        val server = resolveServer(serverInput) ?: return
        if (email.isBlank()) {
            update { it.copy(authError = "请先填写邮箱") }
            return
        }
        val forgot = _state.value.authMode == AuthMode.Forgot
        update { it.copy(codeSending = true, authError = null, authInfo = null) }
        scope.launch {
            val r = api.sendCode(server.httpBase, email.trim(), if (forgot) "reset" else "register")
            val now = SystemClock.elapsedRealtime()
            update {
                when (r) {
                    is ApiResult.Ok -> it.copy(
                        codeSending = false,
                        codeCooldownUntil = now + r.value * 1000L,
                        authInfo = if (forgot) "如果这个邮箱注册过，验证码已经发出，请查收" else "验证码已发出，请查收邮件（也看看垃圾邮件）",
                    )
                    is ApiResult.Err -> it.copy(
                        codeSending = false,
                        codeCooldownUntil = r.retryAfter?.let { s -> now + s * 1000L } ?: it.codeCooldownUntil,
                        authError = r.message,
                    )
                }
            }
        }
    }

    private fun checkCodeForm(email: String, code: String, password: String): Boolean {
        val error = when {
            email.isBlank() -> "请填写邮箱"
            !Regex("^\\d{6}$").matches(code.trim()) -> "请填写邮件里的 6 位验证码"
            password.length < 8 -> "密码至少 8 位"
            else -> null
        }
        if (error != null) update { it.copy(authError = error, authInfo = null) }
        return error == null
    }

    private fun runAuth(block: suspend () -> Unit) {
        if (_state.value.authBusy) return
        update { it.copy(authBusy = true, authError = null, authInfo = null) }
        scope.launch {
            try {
                block()
            } finally {
                update { it.copy(authBusy = false) }
            }
        }
    }

    private fun signedIn(serverInput: String, server: ServerAddress.Result.Ok, token: String, email: String) {
        wsUrl = server.url
        httpBase = server.httpBase
        session = token
        backoffMs = INITIAL_BACKOFF_MS
        scope.launch {
            store.saveServer(serverInput)
            store.saveSession(token)
            store.saveEmail(email)
        }
        update {
            it.copy(
                screen = Screen.Sessions,
                serverInput = serverInput,
                email = email,
                authError = null,
                authInfo = null,
                hosts = emptyList(),
                windows = emptyList(),
                windowsLoaded = false,
            )
        }
        openSocket()
        syncBackgroundService()
    }

    fun logout() {
        stopStreaming(sendStop = true)
        disconnect()
        ApprovalService.stop(app)
        approvalsByHost.clear()
        ApprovalNotifier.sync(app, emptyList(), foreground)
        val token = session
        val base = httpBase
        session = null
        wantHwnd = 0L
        scope.launch {
            store.saveSession(null)
            store.saveLastView("", 0L)
            if (token != null && base != null) api.logout(base, token)
        }
        update {
            AppState(
                screen = Screen.Auth,
                serverInput = it.serverInput,
                email = it.email,
                settings = it.settings,
                collapsedGroups = it.collapsedGroups,
                canLock = it.canLock,
            )
        }
    }

    /**
     * 设置里更换服务器：先退出旧服务器上的登录（通知旧服务器作废令牌），再记下新地址，回到登录页用新服务器上的账号登录，
     * 登录后连新服务器。地址和现在的一样时什么都不做。返回不合法的原因，换好了（或没变）返回 null
     */
    fun changeServer(serverInput: String): String? {
        val input = serverInput.trim()
        val server = when (val r = ServerAddress.parse(input, BuildConfig.ALLOW_CLEARTEXT)) {
            is ServerAddress.Result.Ok -> r
            is ServerAddress.Result.Invalid -> return r.reason
        }
        if (server.url == wsUrl) return null
        logout()
        wsUrl = server.url
        httpBase = server.httpBase
        scope.launch { store.saveServer(input) }
        update { it.copy(serverInput = input, authError = null, authInfo = "已换到 $input，请用这个服务器上的账号登录") }
        return null
    }

    /** 令牌被服务器拒绝（在别处退出、重置了密码、过期）：清掉登录状态，回到登录页 */
    private fun signedOutByServer(message: String) {
        forgetHostStates()
        stopStreaming(sendStop = false)
        session = null
        ApprovalService.stop(app)
        approvalsByHost.clear()
        ApprovalNotifier.sync(app, emptyList(), foreground)
        scope.launch { store.saveSession(null) }
        update {
            AppState(
                screen = Screen.Auth,
                serverInput = it.serverInput,
                email = it.email,
                settings = it.settings,
                collapsedGroups = it.collapsedGroups,
                canLock = it.canLock,
                authError = message,
            )
        }
    }

    private fun deviceName(): String {
        val model = Build.MODEL.orEmpty()
        val maker = Build.MANUFACTURER.orEmpty()
        val name = if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model"
        return name.trim().ifEmpty { "安卓手机" }.take(64)
    }

    // ------------------------------------------------------------------ 信令连接

    private fun connectIfLoggedIn() {
        // App 锁着时界面上看不到东西，但后台接收审批要照常连着（审批面板在解锁后才显示）
        if (!wantConnection || (_state.value.locked && !keepAlive)) return
        if (session != null && wsUrl != null && !signaling.isActive) openSocket()
    }

    private fun openSocket() {
        val url = wsUrl ?: return
        retryJob?.cancel()
        authed = false
        update { it.copy(link = Link.Connecting) }
        signaling.connect(url)
    }

    private fun disconnect() {
        retryJob?.cancel()
        refreshJob?.cancel()
        signaling.close()
        authed = false
        forgetHostStates()
        update { it.copy(link = Link.Offline, refreshing = false).withHostState(null) }
    }

    /** 和服务器的连接断了：电脑的状态不再可信（重连后电脑会重新推），等着的解锁回执也等不到了 */
    private fun forgetHostStates() {
        hostStates.clear()
        hostCmdWaiters.values.forEach { it.complete("closed") }
    }

    private fun sendAuth() {
        val s = session
        if (s == null) signaling.close() else signaling.send(Protocol.auth(s))
    }

    private fun onSocketClosed() {
        authed = false
        forgetHostStates()
        // 服务器会通知电脑这个控制端已离开，电脑随即关掉对应的画面连接，这边也一起清理
        stopStreaming(sendStop = false)
        if (_state.value.opening != null) {
            cancelOpening()
            toast("和服务器的连接断开了，不知道会话打开了没有，重连后看看")
        }
        // 重连后会重新拉窗口列表，关没关掉看列表就知道
        forgetCloseRequests()
        val retry = wantConnection && session != null
        update { it.copy(link = if (retry) Link.Connecting else Link.Offline, refreshing = false, catalogRefreshing = false) }
        if (retry) scheduleReconnect()
    }

    private fun scheduleReconnect() {
        retryJob?.cancel()
        val wait = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        retryJob = scope.launch {
            delay(wait)
            if (wantConnection && session != null) openSocket()
        }
    }

    private fun handle(msg: Incoming) {
        // 电脑回了窗口列表，却一直没推过状态：是不认 host-cmd 的旧版被控端（协议文档 2.9）
        if (msg is Incoming.Windows && msg.host == hostId && msg.host !in hostStates && !_state.value.hostTooOld) {
            update { it.copy(hostTooOld = true) }
        }
        when (msg) {
            is Incoming.AuthOk -> onAuthOk(msg)
            is Incoming.AuthFail -> onAuthFail(msg.reason)
            is Incoming.Hosts -> onHosts(msg.hosts)
            is Incoming.Windows -> if (msg.host == hostId) onWindows(msg.list, msg.thumbs)
            is Incoming.Offer -> if (msg.host == hostId) onOffer(msg)
            is Incoming.Ice -> if (msg.host == peerHost) peer?.addRemoteIce(msg.candidate)
            is Incoming.Selected -> if (msg.host == hostId) update { it.copy(current = CurrentWindow(msg.hwnd, msg.title)) }
            is Incoming.WindowClosed -> if (msg.host == hostId) {
                toast("该窗口已关闭")
                leaveRemoteInternal()
            }
            is Incoming.Sessions -> if (msg.host == hostId) onSessions(msg)
            is Incoming.SessionOpened -> if (msg.host == hostId) onSessionOpened(msg)
            is Incoming.SessionFailed -> if (msg.host == hostId) onSessionFailed(msg)
            is Incoming.CloseWindowResult -> if (msg.host == hostId) onCloseResult(msg)
            is Incoming.HostUpdate -> if (msg.host == hostId) update { it.copy(hostUpdate = msg.state) }
            is Incoming.Approvals -> {
                approvalsByHost[msg.host] = msg.list
                publishApprovals()
            }
            is Incoming.ApprovalResult -> onApprovalResult(msg)
            is Incoming.HostStatePush -> {
                hostStates[msg.host] = msg.state
                if (msg.host == hostId) update { it.withHostState(msg.state) }
            }
            is Incoming.HostCmdResult -> if (msg.host == hostId) {
                hostCmdWaiters[msg.req]?.complete(if (msg.ok) HostCommands.OK else msg.code)
            }
            is Incoming.Error -> if (msg.host == hostId) {
                toast(errorText(msg.code))
                when (msg.code) {
                    "capture-failed" -> leaveRemoteInternal()
                    "host-offline" -> stopStreaming(sendStop = false)
                }
            }
        }
    }

    private fun onAuthOk(msg: Incoming.AuthOk) {
        authed = true
        backoffMs = INITIAL_BACKOFF_MS
        iceServers = msg.iceServers
        if (msg.email.isNotEmpty() && msg.email != _state.value.email) scope.launch { store.saveEmail(msg.email) }
        update { it.copy(link = Link.Online, hosts = msg.hosts, email = msg.email.ifEmpty { it.email }) }
        chooseHost()
        requestList()
        if (_state.value.listTab == ListTab.All) refreshCatalog()
        val now = SystemClock.elapsedRealtime()
        if (lastUpdateCheck == 0L || now - lastUpdateCheck > UPDATE_CHECK_EVERY_MS) checkAppUpdate(manual = false)
    }

    private fun onAuthFail(reason: String) {
        signaling.close() // 服务器随后会断开，这里先关掉，免得触发普通的断线重连
        authed = false
        when (reason) {
            "locked" -> {
                toast("连接失败次数太多，稍后自动重试")
                update { it.copy(link = Link.Connecting) }
                backoffMs = 60_000L
                scheduleReconnect()
            }
            "bad-proto" -> signedOutByServer("App 版本太旧，和服务器不兼容，请更新")
            "revoked" -> signedOutByServer("账号已在别处退出登录或修改了密码，请重新登录")
            else -> signedOutByServer("登录已过期，请重新登录")
        }
    }

    private fun onHosts(hosts: List<HostInfo>) {
        val wasOnline = _state.value.hostOnline
        update { it.copy(hosts = hosts) }
        // 下线了的电脑，它的审批也结束了
        val onlineIds = hosts.filter { it.online }.map { it.id }.toSet()
        if (approvalsByHost.keys.retainAll(onlineIds)) publishApprovals()
        hostStates.keys.retainAll(onlineIds)
        if (hostId != null && hosts.none { it.id == hostId }) setHost(null)
        chooseHost()
        val online = _state.value.hostOnline
        if (wasOnline && !online) stopStreaming(sendStop = false)
        // 电脑下线了：它的锁屏、平铺状态不知道了，等它上线后重新推
        if (!online) update { it.withHostState(null) }
        if (online && (!wasOnline || _state.value.windows.isEmpty())) {
            requestList()
            if (_state.value.listTab == ListTab.All) refreshCatalog()
        }
    }

    /** 选电脑：记住的那台还在就用它；否则只有一台（在线）时自动选上 */
    private fun chooseHost() {
        val hosts = _state.value.hosts
        if (hostId != null && hosts.any { it.id == hostId }) return
        val online = hosts.filter { it.online }
        val pick = when {
            online.size == 1 -> online[0]
            hosts.size == 1 -> hosts[0]
            else -> null
        }
        setHost(pick?.id)
    }

    /** 用户在会话列表上方点选另一台电脑 */
    fun selectHost(id: String) {
        if (id == hostId) return
        setHost(id)
        requestList()
    }

    private fun setHost(id: String?) {
        if (id == hostId) return
        stopStreaming(sendStop = true)
        wantHwnd = 0L
        scope.launch { store.saveLastView(id.orEmpty(), 0L) }
        if (_state.value.opening != null) cancelOpening()
        forgetCloseRequests()
        update {
            it.copy(
                hostId = id,
                windows = emptyList(),
                windowsLoaded = false,
                current = null,
                catalog = emptyList(),
                catalogPhase = CatalogPhase.None,
                hostUpdate = null,
            ).withHostState(id?.let { h -> hostStates[h] })
        }
    }

    fun refreshWindows() = requestList()

    private fun requestList() {
        val host = hostId
        if (!authed || host == null || !_state.value.hostOnline) return
        signaling.send(Protocol.list(host))
        update { it.copy(refreshing = true) }
        refreshJob?.cancel()
        refreshJob = scope.launch {
            delay(REFRESH_TIMEOUT_MS)
            update { it.copy(refreshing = false) }
        }
    }

    /**
     * 电脑发来窗口列表。被控端 0.9.7 起分两次回（协议文档 2.4）：先是不带缩略图的一份（[thumbs] 为
     * [Protocol.THUMBS_PENDING]），几十毫秒就到，这时标题、个数就对了、刷新的转圈也停，图先沿用手上的；
     * 电脑截完图再来一份带图的（[Protocol.THUMBS_DONE]）。旧版被控端只回一份带图的，[thumbs] 为 null
     */
    private fun onWindows(list: List<RemoteWindow>, thumbs: String?) {
        scope.launch {
            val items = if (thumbs == Protocol.THUMBS_PENDING) {
                // 这一段不挂起，保证比随后那份带图的先生效
                val old = _state.value.windows.associate { it.hwnd to it.thumb }
                list.map { WindowItem(it.hwnd, it.title, it.minimized, old[it.hwnd], it.closable, thumbLoading = true) }
            } else {
                withContext(Dispatchers.Default) {
                    list.map { WindowItem(it.hwnd, it.title, it.minimized, decodeThumb(it.thumb), it.closable) }
                }
            }
            refreshJob?.cancel()
            update { it.copy(windows = items, windowsLoaded = true, refreshing = false) }
            // 补缩略图的那一份：下面的事前一份已经办过了
            if (thumbs == Protocol.THUMBS_DONE) return@launch

            // 还没有画面时，自动回到想看的那个窗口（断线重连、回到前台、冷启动）
            if (peer != null || wantHwnd == 0L) return@launch
            val target = items.firstOrNull { it.hwnd == wantHwnd }
            when {
                target != null -> select(target.hwnd, target.title)
                _state.value.screen == Screen.Remote -> {
                    toast("刚才查看的窗口已经不在了")
                    leaveRemoteInternal()
                }
                else -> forgetWindow()
            }
        }
    }

    // ------------------------------------------------------------------ 浏览、打开、新建 Claude 会话（协议文档 2.5）

    fun setListTab(tab: ListTab) {
        if (tab == _state.value.listTab) return
        update { it.copy(listTab = tab) }
        if (tab == ListTab.All) refreshCatalog() else requestList()
    }

    fun refreshCatalog() {
        val host = hostId
        if (!authed || host == null || !_state.value.hostOnline) return
        signaling.send(Protocol.listSessions(host))
        update { it.copy(catalogRefreshing = true) }
        catalogJob?.cancel()
        catalogJob = scope.launch {
            delay(REFRESH_TIMEOUT_MS)
            // 旧版被控端不认这个请求，不会回话
            update {
                it.copy(
                    catalogRefreshing = false,
                    catalogPhase = if (it.catalogPhase == CatalogPhase.None) CatalogPhase.NoReply else it.catalogPhase,
                )
            }
        }
    }

    private fun onSessions(msg: Incoming.Sessions) {
        catalogJob?.cancel()
        update {
            it.copy(
                catalog = msg.groups,
                catalogPhase = if (msg.available) CatalogPhase.Loaded else CatalogPhase.Unavailable,
                catalogRefreshing = false,
            )
        }
    }

    /** 打开一个会话：电脑上已经开着就直接看，没开就先在电脑上开成单独窗口 */
    fun openSession(entry: SessionEntry) {
        val name = entry.title.ifEmpty { "会话" }
        startOpening(if (entry.open) "正在切到「$name」…" else "正在电脑上打开「$name」…") { host, req ->
            Protocol.openSession(host, entry.id, req)
        }
    }

    /** 在这个环境下新建会话：电脑上开一个新的会话窗口并选好环境，第一句话在画面里输入 */
    fun newSession(group: SessionGroup) {
        val env = group.env ?: return
        startOpening("正在电脑上新建会话（${group.name}）…") { host, req -> Protocol.newSession(host, env, req) }
    }

    private fun startOpening(label: String, build: (host: String, req: String) -> String) {
        if (_state.value.opening != null) return
        val host = hostId
        if (!authed || host == null || !_state.value.hostOnline) {
            toast("这台电脑不在线")
            return
        }
        val req = "s${++openSeq}"
        signaling.send(build(host, req))
        update { it.copy(opening = OpeningSession(req, label)) }
        openJob?.cancel()
        openJob = scope.launch {
            delay(OPEN_TIMEOUT_MS)
            if (_state.value.opening?.req == req) {
                update { it.copy(opening = null) }
                toast("电脑没有回应（被控端可能是旧版本），没能打开")
            }
        }
    }

    /** 不等了。电脑那边可能还是会把窗口开出来，但回话来了也不再跳过去 */
    fun cancelOpening() {
        openJob?.cancel()
        update { it.copy(opening = null) }
    }

    private fun onSessionOpened(msg: Incoming.SessionOpened) {
        if (_state.value.opening?.req != msg.req) return
        openJob?.cancel()
        update { it.copy(opening = null) }
        if (!msg.envOk) toast("没能自动选上环境，请在画面里手动选")
        select(msg.hwnd, msg.title)
    }

    private fun onSessionFailed(msg: Incoming.SessionFailed) {
        if (_state.value.opening?.req != msg.req) return
        openJob?.cancel()
        update { it.copy(opening = null) }
        toast(sessionErrorText(msg.code))
    }

    private fun sessionErrorText(code: String): String = when (code) {
        "busy" -> "电脑正在打开另一个会话，稍等再试"
        "locked" -> "电脑锁屏了，解锁后再试"
        "not-found" -> "电脑上找不到这个会话了，下拉刷新一下"
        "no-title" -> "这个会话还没有标题，没法自动打开，请在电脑上操作"
        "no-claude" -> "电脑上没找到 Claude 桌面端"
        "no-main" -> "Claude 主窗口没有出来，请确认 Claude 在运行"
        "ui-missing" -> "没在 Claude 界面里找到要点的菜单（可能 Claude 升级了），请在电脑上操作"
        "no-window" -> "电脑上没等到新窗口出来，请在电脑上看看"
        "timeout" -> "电脑上的操作超时了"
        "stuck" -> "Claude 给的会话窗口卡住了，没能显示这个会话，请在电脑上重启 Claude"
        else -> "没能打开（$code）"
    }

    // ------------------------------------------------------------------ 关闭会话窗口（协议文档 2.8）

    /**
     * 关掉电脑上的一个会话窗口，不用确认（用户定的）：会话不删，在后台照常跑，"全部会话"里能再打开。
     * 被控端是旧版本（列表里没有 closable）时弹说明，请它升级。
     */
    fun closeWindow(item: WindowItem) {
        val host = hostId ?: return
        if (!authed || !_state.value.hostOnline) {
            toast("这台电脑不在线")
            return
        }
        when (item.closable) {
            null -> {
                update { it.copy(closeUnsupported = true) }
                return
            }
            false -> return
            true -> Unit
        }
        if (item.hwnd in _state.value.closingWindows) return
        val req = "c${++closeSeq}"
        closeRequests[req] = item
        signaling.send(Protocol.closeWindow(host, item.hwnd, item.title, req))
        update { it.copy(closingWindows = it.closingWindows + item.hwnd) }
        scope.launch {
            delay(WindowClose.TIMEOUT_MS)
            if (closeRequests.remove(req) != null) {
                update { it.copy(closingWindows = it.closingWindows - item.hwnd) }
                toast("电脑没有回应，没能关掉「${item.title}」")
                requestList()
            }
        }
    }

    fun dismissCloseUnsupported() = update { it.copy(closeUnsupported = false) }

    private fun onCloseResult(msg: Incoming.CloseWindowResult) {
        val item = closeRequests.remove(msg.req) ?: return
        update { it.copy(closingWindows = it.closingWindows - item.hwnd) }
        if (WindowClose.removesCard(msg.ok, msg.code)) {
            // 卡片先拿掉，电脑随后会推新的窗口列表
            update { it.copy(windows = it.windows.filterNot { w -> w.hwnd == item.hwnd }) }
            // 这个句柄以后可能被 Claude 拿去开别的会话，别再自动选回它
            if (wantHwnd == item.hwnd) forgetWindow()
            if (_state.value.current?.hwnd == item.hwnd) {
                stopStreaming(sendStop = true)
                update { it.copy(current = null, screen = Screen.Sessions) }
            }
        }
        toast(WindowClose.resultText(msg.ok, msg.code, item.title))
    }

    private fun forgetCloseRequests() {
        closeRequests.clear()
        if (_state.value.closingWindows.isNotEmpty()) update { it.copy(closingWindows = emptySet()) }
    }

    // ------------------------------------------------------------------ 审批（docs/09）

    private fun publishApprovals() {
        val hosts = _state.value.hosts
        val list = approvalsByHost.flatMap { (h, items) ->
            val name = hosts.firstOrNull { it.id == h }?.name ?: "电脑"
            items.map { PendingApproval(h, name, it) }
        }.sortedBy { it.item.createdAt }
        val ids = list.map { it.item.id }.toSet()
        update {
            it.copy(
                approvals = list,
                answering = it.answering.intersect(ids),
                // 都处理完了就收起面板
                showApprovals = it.showApprovals && list.isNotEmpty(),
            )
        }
        ApprovalNotifier.sync(app, list, foreground)
    }

    fun openApprovals() = update { it.copy(showApprovals = it.approvals.isNotEmpty()) }

    /** 从通知打开 App 时：审批列表可能还没从电脑推过来（刚重连），等一会儿再打开面板 */
    fun openApprovalsWhenReady() {
        scope.launch {
            repeat(20) {
                if (_state.value.approvals.isNotEmpty()) {
                    openApprovals()
                    return@launch
                }
                delay(250)
            }
        }
    }

    fun closeApprovals() = update { it.copy(showApprovals = false) }

    /**
     * 回答一条审批：[choice] 是 allow 或 deny，拒绝时 [text] 是说明；回答提问时 [answers] 是
     * 问题原文 -> 选项或自己填的文字（多选给列表）。没连上服务器时返回 false。
     */
    fun answerApproval(hostId: String, id: String, choice: String, text: String, answers: Map<String, Any>?): Boolean {
        if (!authed) return false
        val req = "a${++approvalSeq}"
        if (!signaling.send(Protocol.approvalAnswer(hostId, id, req, choice, text, answers))) return false
        update { it.copy(answering = it.answering + id) }
        return true
    }

    private fun onApprovalResult(msg: Incoming.ApprovalResult) {
        update { it.copy(answering = it.answering - msg.id) }
        if (msg.ok) return
        toast(
            when (msg.code) {
                "gone" -> "这个审批已经在别处答了或已经结束"
                "bad" -> "答案不完整，请每个问题都选一下"
                else -> "没能提交（${msg.code}）"
            },
        )
    }

    // ------------------------------------------------------------------ 升级（docs/08）

    /** 查服务器上有没有新的 App 安装包；[manual] 为真时把"已是最新"之类的结果也提示出来 */
    fun checkAppUpdate(manual: Boolean) {
        val base = httpBase
        val token = session
        if (base == null || token == null) return
        lastUpdateCheck = SystemClock.elapsedRealtime()
        scope.launch {
            when (val r = updater.check(base, token, BuildConfig.VERSION_CODE)) {
                is AppUpdater.Check.Found -> update {
                    // 服务器上又出了更新的版本：之前下好的作废
                    if (it.appUpdate?.versionCode != r.info.versionCode) it.copy(appUpdate = r.info, appUpdateReady = false) else it
                }
                AppUpdater.Check.None -> {
                    update { it.copy(appUpdate = null) }
                    if (manual) toast("已是最新版本")
                }
                is AppUpdater.Check.Failed -> if (manual) toast("检查更新失败：${r.message}")
            }
        }
    }

    /** 下载新安装包并打开系统安装界面 */
    fun startAppUpdate() {
        val info = _state.value.appUpdate ?: return
        val base = httpBase ?: return
        val token = session ?: return
        if (updateJob?.isActive == true) return
        val ready = downloadedApk?.takeIf { it.first == info.versionCode && it.second.exists() }?.second
        if (ready != null) {
            installApk(ready)
            return
        }
        update { it.copy(appUpdateProgress = 0) }
        updateJob = scope.launch {
            try {
                val file = updater.download(base, token, info) { p -> update { it.copy(appUpdateProgress = p) } }
                downloadedApk = info.versionCode to file
                update { it.copy(appUpdateProgress = null, appUpdateReady = true) }
                installApk(file)
            } catch (e: CancellationException) {
                update { it.copy(appUpdateProgress = null) }
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "下载新版本失败", e)
                update { it.copy(appUpdateProgress = null) }
                toast("下载新版本失败：${e.message ?: "网络出错"}")
            }
        }
    }

    /** 交给系统安装；第一次要用户在系统设置里允许本 App 安装应用，允许后回来再点"安装" */
    private fun installApk(file: java.io.File) {
        if (updater.canInstall()) {
            updater.install(file)
        } else {
            toast("新版本已下载。请在接下来的设置里允许 RemoteClaude 安装应用，然后回来点「安装」")
            updater.openInstallPermission()
        }
    }

    /** 电脑被控端升级：status 只问状态、check 检查更新、install 马上升级（协议文档 2.6） */
    fun hostUpdate(op: String) {
        val host = hostId ?: return
        if (!authed || !_state.value.hostOnline) return
        signaling.send(Protocol.hostUpdate(host, op))
        when (op) {
            "install" -> toast("电脑上的被控端会重启升级，稍后自动重连")
            "check" -> toast("已让电脑检查更新")
        }
    }

    // ------------------------------------------------------------------ 选择窗口与画面连接

    fun select(hwnd: Long, title: String) {
        val host = hostId ?: return
        wantHwnd = hwnd
        scope.launch { store.saveLastView(host, hwnd) }
        update {
            it.copy(
                current = CurrentWindow(hwnd, title),
                screen = Screen.Remote,
                rtc = if (peer == null) RtcPhase.Connecting else it.rtc,
            )
        }
        // 已有画面连接时，电脑直接换画面，回 selected；否则新建连接，回 offer
        if (authed) signaling.send(Protocol.select(host, hwnd))
    }

    /** 从画面页返回会话列表：停止看画面，之后不再自动选回这个窗口 */
    fun leaveRemote() = leaveRemoteInternal()

    private fun leaveRemoteInternal() {
        stopStreaming(sendStop = true)
        forgetWindow()
        update { it.copy(current = null, screen = Screen.Sessions) }
        requestList()
        // 刚才可能打开了新的会话窗口，全部会话里的"已打开"标记要跟着变
        if (_state.value.listTab == ListTab.All) refreshCatalog()
    }

    private fun forgetWindow() {
        wantHwnd = 0L
        val host = hostId.orEmpty()
        scope.launch { store.saveLastView(host, 0L) }
    }

    private fun onOffer(msg: Incoming.Offer) {
        // 电脑发来新的 offer 时，它那边的旧连接已经关了
        stopStreaming(sendStop = false)
        val session = try {
            PeerSession(rtc, iceServers, peerCallbacks)
        } catch (e: Exception) {
            Log.e(TAG, "创建画面连接失败", e)
            toast("创建画面连接失败")
            return
        }
        peer = session
        peerHost = msg.host
        statsReader.reset()
        update { it.copy(current = CurrentWindow(msg.hwnd, msg.title), rtc = RtcPhase.Connecting, hasVideo = false) }
        session.acceptOffer(
            msg.sdp,
            onAnswer = { sdp -> if (peer === session) signaling.send(Protocol.answer(msg.host, sdp)) },
            onError = { err ->
                Log.e(TAG, err)
                if (peer === session) {
                    toast("建立画面连接失败")
                    update { it.copy(rtc = RtcPhase.Failed) }
                }
            },
        )
        startStats()
    }

    private val peerCallbacks = object : PeerSession.Callbacks {
        override fun onLocalIce(session: PeerSession, candidate: IceCandidateSpec) {
            val host = peerHost
            if (session === peer && host != null) signaling.send(Protocol.ice(host, candidate))
        }

        override fun onVideoTrack(session: PeerSession, track: VideoTrack) {
            if (session !== peer) return
            videoTrack = track
            val probe = FirstFrameProbe {
                if (session === peer) update { it.copy(hasVideo = true) }
            }
            frameProbe = probe
            runCatching { track.addSink(probe) }
            renderer?.let { runCatching { track.addSink(it) } }
        }

        override fun onConnectionState(session: PeerSession, state: PeerConnection.PeerConnectionState) {
            if (session !== peer) return
            val phase = when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> RtcPhase.Connected
                PeerConnection.PeerConnectionState.FAILED -> RtcPhase.Failed
                else -> RtcPhase.Connecting
            }
            update { it.copy(rtc = phase) }
            reselectJob?.cancel()
            when (state) {
                PeerConnection.PeerConnectionState.FAILED -> scheduleReselect(300)
                PeerConnection.PeerConnectionState.DISCONNECTED -> scheduleReselect(5000)
                else -> Unit
            }
        }

        override fun onInputError(session: PeerSession, error: InputError) {
            if (session === peer) toast(error.withDetail(errorText(error.code)))
        }

        override fun onImageReply(session: PeerSession, reply: ImageReply) {
            if (session === peer) imageWaiters[reply.id]?.complete(reply.code ?: IMAGE_OK)
        }

        override fun onLockState(session: PeerSession, state: LockState) {
            if (session === peer) {
                update { it.copy(pcLocked = state.locked, unlockAvailable = state.unlockAvailable, unlockUntrusted = state.unlockUntrusted) }
            }
        }

        override fun onUnlockResult(session: PeerSession, result: UnlockResult) {
            if (session === peer) unlockWaiters[result.id]?.complete(result.code ?: IMAGE_OK)
        }

        override fun onTileState(session: PeerSession, state: TileState) {
            if (session === peer) update { it.copy(tileAvailable = state.available, tilePaused = state.paused) }
        }

        override fun onFileCaps(session: PeerSession, max: Long) {
            if (session === peer) update { it.copy(fileMax = max) }
        }

        override fun onFileReply(session: PeerSession, reply: FileReply) {
            if (session === peer) fileWaiters[reply.id]?.complete(reply)
        }

        override fun onClipboardText(session: PeerSession, text: String) {
            if (session === peer) receiveClipboard(text)
        }

        override fun onClipboardSkipped(session: PeerSession, code: String) {
            if (session !== peer || !_state.value.settings.syncClipboard) return
            if (code == "too-large") toast("电脑上复制的文字太长，没有同步到手机")
        }
    }

    /**
     * 电脑上新复制的文字（协议文档 4.9）：放进手机剪贴板，在别的 App 里就能直接粘贴。
     * 每次都提示一下：这次复制是电脑那边发生的，不提示的话手机上看不出剪贴板换了内容。
     */
    private fun receiveClipboard(text: String) {
        if (!_state.value.settings.syncClipboard || text.isEmpty()) return
        val ok = runCatching {
            val cm = app.getSystemService(ClipboardManager::class.java) ?: error("没有剪贴板服务")
            cm.setPrimaryClip(ClipData.newPlainText("RemoteClaude", text))
        }.onFailure { Log.w(TAG, "写手机剪贴板失败", it) }.isSuccess
        toast(if (ok) "已复制电脑上的文字" else "电脑上复制的文字没能放进手机剪贴板")
    }

    /**
     * 画面连接断了且自己恢复不了：关掉两边的旧连接，重新向电脑要一次画面。
     * 先发 stop 让电脑也关掉旧连接，否则它可能以为连接还在，只换画面不重新协商。
     */
    private fun scheduleReselect(delayMs: Long) {
        reselectJob = scope.launch {
            delay(delayMs)
            val cur = _state.value.current ?: return@launch
            val host = hostId ?: return@launch
            val p = peer ?: return@launch
            if (p.connectionState == PeerConnection.PeerConnectionState.CONNECTED) return@launch
            if (!authed || !_state.value.hostOnline) return@launch
            Log.i(TAG, "画面连接已断开，重新请求")
            stopStreaming(sendStop = true)
            update { it.copy(rtc = RtcPhase.Connecting) }
            signaling.send(Protocol.select(host, cur.hwnd))
        }
    }

    /** 关掉画面连接，但保留"想看哪个窗口"，以便之后自动恢复 */
    private fun stopStreaming(sendStop: Boolean) {
        reselectJob?.cancel()
        statsJob?.cancel()
        _stats.value = null
        input.reset()
        val p = peer ?: run {
            update { it.copy(rtc = RtcPhase.None, hasVideo = false).withHostState(hostStates[hostId]) }
            return
        }
        val host = peerHost
        if (sendStop && authed && host != null) signaling.send(Protocol.stop(host))
        // 先把渲染器从轨道上摘下来，轨道会随连接一起释放
        val t = videoTrack
        if (t != null) {
            renderer?.let { r -> runCatching { t.removeSink(r) } }
            frameProbe?.let { probe -> runCatching { t.removeSink(probe) } }
        }
        videoTrack = null
        frameProbe = null
        peer = null
        peerHost = null
        imageWaiters.values.forEach { it.complete("closed") }
        unlockWaiters.values.forEach { it.complete("closed") }
        fileWaiters.forEach { (id, w) -> w.complete(FileReply(id, null, null, false, "closed")) }
        p.close()
        // 锁屏、平铺状态：新版被控端经信令通道也推（协议文档 2.9），没有画面也知道；旧版的就不知道了
        update { it.copy(rtc = RtcPhase.None, hasVideo = false, fileMax = null).withHostState(hostStates[hostId]) }
    }

    // ------------------------------------------------------------------ 画面显示与输入

    fun attachRenderer(sink: VideoSink) {
        renderer = sink
        videoTrack?.let { runCatching { it.addSink(sink) } }
    }

    fun detachRenderer(sink: VideoSink) {
        if (renderer !== sink) return
        videoTrack?.let { runCatching { it.removeSink(sink) } }
        renderer = null
    }

    val stageListener = object : RemoteStageView.Listener {
        override fun onTap(point: RemotePoint) {
            if (!input.click(point, InputEvents.BUTTON_LEFT)) toast(NOT_READY)
        }

        override fun onLongPress(point: RemotePoint) {
            if (!input.click(point, InputEvents.BUTTON_RIGHT)) toast(NOT_READY)
        }

        override fun onScroll(point: RemotePoint, dx: Double, dy: Double) = input.wheel(point, dx, dy)

        // 是否已出画面由 FirstFrameProbe 判断，这里不需要处理
        override fun onVideoSize(width: Int, height: Int) = Unit
    }

    fun sendKey(key: String, mods: Int) {
        if (!input.key(key, mods)) toast(NOT_READY)
    }

    /** 调电脑上 Claude 的字体大小：给正在看的窗口按 Claude 的缩放快捷键，见 [FontZoom] */
    fun fontZoom(step: FontZoom) = sendKey(step.key, step.mods)

    /** 发送文字，[pressEnter] 为真时再按一次回车。返回是否已发出（发出后调用方清空输入框） */
    fun sendText(text: String, pressEnter: Boolean): Boolean {
        if (peer?.inputOpen != true) {
            toast(NOT_READY)
            return false
        }
        // 文件走单独的通道，文字不会排在它后面：这时发出去，路径就落在文字之后了。留在输入框里，等路径粘贴好再发
        if (fileUploading) {
            toast("文件还在发送，等路径粘贴好再发文字")
            return false
        }
        if (text.isNotEmpty()) input.text(text)
        if (pressEnter) input.key("Enter", 0)
        return true
    }

    // ------------------------------------------------------------------ 发图片（协议文档 4.5）

    /** 打开系统选图或选文件界面之前调用 */
    fun beginPick() {
        picking = true
    }

    /** 选图界面返回后调用；[uri] 为 null 表示用户取消了 */
    fun endPickImage(uri: Uri?) {
        picking = false
        pickGuardJob?.cancel()
        if (uri != null) sendImage(uri)
    }

    private fun sendImage(uri: Uri) {
        if (uploadJob?.isActive == true) {
            toast(if (fileUploading) "文件还在发送" else "上一张图片还在发送")
            return
        }
        if (peer?.inputOpen != true) {
            toast(NOT_READY)
            return
        }
        uploadJob = scope.launch {
            update { it.copy(upload = UploadProgress(preparing = true)) }
            try {
                val image = try {
                    withContext(Dispatchers.Default) { ImagePrep.prepare(app, uri) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w(TAG, "读取图片失败", e)
                    toast("读取图片失败")
                    return@launch
                }
                if (image.bytes.size > ImagePrep.MAX_BYTES) {
                    toast("图片太大了")
                    return@launch
                }
                Log.i(TAG, "发送图片 ${image.width}x${image.height} ${image.mime} ${image.bytes.size / 1024} KB")
                toast(transferImage(image.bytes, image.mime))
            } finally {
                update { it.copy(upload = null) }
            }
        }
    }

    /** 分块发出图片并等电脑的回执，返回给用户看的结果 */
    private suspend fun transferImage(bytes: ByteArray, mime: String): String {
        val s = peer?.takeIf { it.inputOpen } ?: return NOT_READY
        val id = java.lang.Long.toString(System.nanoTime() and 0xffffffffffL, 36)
        val waiter = CompletableDeferred<String>()
        imageWaiters[id] = waiter
        try {
            if (!s.sendInput(InputEvents.imageBegin(id, mime, bytes.size))) return NOT_READY
            var offset = 0
            while (offset < bytes.size) {
                if (peer !== s || !s.inputOpen) return errorText("closed")
                // 排队的数据太多就等一等，既不撑爆通道的缓冲，进度条也更接近实际
                if (s.bufferedAmount() > MAX_BUFFERED) {
                    delay(10)
                    continue
                }
                val n = minOf(IMAGE_CHUNK, bytes.size - offset)
                if (!s.sendBinary(bytes, offset, n)) return errorText("closed")
                offset += n
                update { it.copy(upload = UploadProgress(offset.toLong(), bytes.size.toLong())) }
            }
            if (!s.sendInput(InputEvents.imageEnd(id))) return errorText("closed")
            update { it.copy(upload = UploadProgress(bytes.size.toLong(), bytes.size.toLong(), pasting = true)) }
            val code = withTimeoutOrNull(IMAGE_REPLY_TIMEOUT_MS) { waiter.await() }
                ?: return "电脑没有回应，电脑上的被控端可能需要更新"
            return if (code == IMAGE_OK) "图片已粘贴到输入框" else errorText(code)
        } finally {
            imageWaiters.remove(id)
        }
    }

    // ------------------------------------------------------------------ 发文件（协议文档 4.8）

    /** 正在发文件，还没等到电脑的回执 */
    private val fileUploading: Boolean get() = uploadJob?.isActive == true && _state.value.upload?.fileName != null

    /** 选文件之前检查：电脑上的被控端能不能收。不能时提示原因，返回 false */
    fun canSendFile(): Boolean {
        val reason = when {
            uploadJob?.isActive == true -> if (fileUploading) "上一个文件还在发送" else "图片还在发送"
            peer?.inputOpen != true -> NOT_READY
            _state.value.fileMax == null -> "电脑上的被控端版本太旧，更新到 0.9.0 以后才能发文件"
            else -> null
        }
        reason?.let(::toast)
        return reason == null
    }

    /** 选文件界面返回后调用；[uri] 为 null 表示用户取消了 */
    fun endPickFile(uri: Uri?) {
        picking = false
        pickGuardJob?.cancel()
        if (uri != null) sendFile(uri)
    }

    /** 进度条上的"取消"：不发了，电脑删掉已经收到的部分 */
    fun cancelUpload() {
        val job = uploadJob ?: return
        if (!job.isActive || _state.value.upload?.fileName == null || _state.value.upload?.pasting == true) return
        job.cancel()
        toast("已取消发送")
    }

    private fun sendFile(uri: Uri) {
        if (!canSendFile()) return
        val s = peer ?: return
        val max = _state.value.fileMax ?: return
        uploadJob = scope.launch {
            update { it.copy(upload = UploadProgress(preparing = true, fileName = "")) }
            var source: FileSource? = null
            try {
                source = try {
                    withContext(Dispatchers.IO) { FileSource.from(app, uri, max) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: FileSource.TooLarge) {
                    toast("「${e.name}」太大了，最大 ${FileUploads.limitText(max)}")
                    return@launch
                } catch (e: Exception) {
                    ensureActive()
                    Log.w(TAG, "读取文件失败", e)
                    toast("读取文件失败")
                    return@launch
                }
                Log.i(TAG, "发送文件，${source.size / 1024} KB")
                toast(transferFile(s, source))
            } finally {
                source?.release()
                update { it.copy(upload = null) }
            }
        }
    }

    /**
     * 经 file 通道分块发出文件并等电脑的回执，返回给用户看的结果。
     * 一边发一边算 SHA-256，发完交给电脑核对。中途取消、出错时告诉电脑删掉收到的部分。
     */
    private suspend fun transferFile(s: PeerSession, src: FileSource): String {
        val total = src.size
        val name = src.name
        var shown = UploadProgress(0, total, fileName = name)
        update { it.copy(upload = shown) }
        var lastShown = 0L
        fun progress(done: Long, force: Boolean = false) {
            val now = SystemClock.elapsedRealtime()
            if (!force && now - lastShown < 100) return
            lastShown = now
            shown = shown.copy(sent = done)
            update { it.copy(upload = shown) }
        }

        if (!s.openFileChannel()) return "没能和电脑建立传文件的通道"
        val openBy = SystemClock.elapsedRealtime() + FileUploads.OPEN_TIMEOUT_MS
        while (!s.fileOpen) {
            if (peer !== s || s.fileClosed) return FILE_CLOSED
            if (SystemClock.elapsedRealtime() > openBy) return "没能和电脑建立传文件的通道"
            delay(20)
        }

        val id = "f" + java.lang.Long.toString(System.nanoTime() and 0xffffffffffL, 36)
        val waiter = CompletableDeferred<FileReply>()
        fileWaiters[id] = waiter
        var ended = false
        try {
            if (!s.sendFileText(InputEvents.fileBegin(id, name, total))) return FILE_CLOSED
            val digest = MessageDigest.getInstance("SHA-256")
            val stall = StallWatch(FileUploads.STALL_MS)
            val buf = ByteArray(FileUploads.READ_BLOCK)
            var handed = 0L
            src.open().use { input ->
                while (true) {
                    val n = withContext(Dispatchers.IO) { input.read(buf) }
                    if (n < 0) break
                    if (handed + n > total) return "文件在发送过程中变了，没有发完"
                    digest.update(buf, 0, n)
                    var off = 0
                    while (off < n) {
                        if (peer !== s || !s.fileOpen) return FILE_CLOSED
                        // 电脑可能中途就回了错误（比如磁盘不够），不用再发了
                        if (waiter.isCompleted) return fileReplyText(waiter.await())
                        val buffered = s.fileBufferedAmount()
                        val delivered = FileUploads.delivered(handed, buffered)
                        if (stall.stalled(delivered, SystemClock.elapsedRealtime())) return "传输卡住了，文件没有发完"
                        if (buffered > FileUploads.MAX_BUFFERED) {
                            progress(delivered)
                            delay(10)
                            continue
                        }
                        val len = minOf(FileUploads.CHUNK, n - off)
                        if (!s.sendFileBinary(buf, off, len)) return FILE_CLOSED
                        off += len
                        handed += len
                    }
                    progress(FileUploads.delivered(handed, s.fileBufferedAmount()))
                }
            }
            if (handed != total) return "文件在发送过程中变了，没有发完"
            if (!s.sendFileText(InputEvents.fileEnd(id, FileUploads.hex(digest.digest())))) return FILE_CLOSED
            ended = true
            // 通道里排着的还在往外发，进度条跟着走到头
            while (!waiter.isCompleted) {
                val buffered = s.fileBufferedAmount()
                if (buffered == 0L) break
                if (peer !== s || !s.fileOpen) return FILE_CLOSED
                val delivered = FileUploads.delivered(handed, buffered)
                if (stall.stalled(delivered, SystemClock.elapsedRealtime())) return "传输卡住了，文件没有发完"
                progress(delivered)
                delay(20)
            }
            progress(total, force = true)
            shown = shown.copy(pasting = true)
            update { it.copy(upload = shown) }
            val reply = withTimeoutOrNull(FileUploads.REPLY_TIMEOUT_MS) { waiter.await() }
                ?: return "电脑没有回应，不知道文件存好没有"
            if (reply.code == "closed") return "画面连接断开了，没等到电脑确认文件存好没有"
            return fileReplyText(reply)
        } finally {
            fileWaiters.remove(id)
            // 走输入通道：file 通道里可能还排着上百 KB 的数据，取消排在后面要等它们发完才到
            if (!ended && peer === s) s.sendInput(InputEvents.fileCancel(id))
        }
    }

    private fun fileReplyText(r: FileReply): String {
        val path = r.path ?: return when (r.code) {
            "closed" -> FILE_CLOSED
            else -> errorText(r.code ?: "unknown")
        }
        val shown = r.name ?: path.substringAfterLast('\\')
        if (r.pasted) return "「$shown」已存到电脑，路径已粘贴到输入框"
        // 放进手机上的输入框：电脑能操作了（比如解锁以后），用户接着写要说的话，点"发送"连路径一起发出去
        _inputFill.tryEmit(FileUploads.pathForInput(path))
        return "「$shown」已存到电脑，但路径没能粘贴（${FileUploads.pasteFailureText(r.code)}），已放进下面的输入框，接着写要说的话再点发送"
    }

    // ------------------------------------------------------------------ 操作电脑：窗口平铺、锁定与解锁（协议文档 4.6、4.7、2.9）

    /**
     * 给电脑发一条和具体窗口无关的命令。连着画面时走数据通道（[viaPeer]，旧版被控端只认这条路）；
     * 没连画面时走信令通道（协议文档 2.9，被控端 0.9.6 起），停在会话列表也能用。
     * 发不出去时提示原因，返回 false
     */
    private fun sendHostCommand(op: String, viaPeer: String): Boolean {
        if (peer?.sendInput(viaPeer) == true) return true
        val host = hostCommandTarget() ?: return false
        if (signaling.send(Protocol.hostCmd(host, op))) return true
        toast("这台电脑不在线")
        return false
    }

    /** 能经信令通道收命令的那台电脑；不行时提示原因，返回 null */
    private fun hostCommandTarget(): String? {
        val host = hostId
        val reason = when {
            host == null || !authed || !_state.value.hostOnline -> "这台电脑不在线"
            host in hostStates -> return host
            // 旧版被控端只能走画面连接：在画面页是画面还没连上，在会话列表是它不认这种命令
            _state.value.screen == Screen.Remote -> NOT_READY
            else -> HostCommands.UNSUPPORTED_TOAST
        }
        toast(reason)
        return null
    }

    /** [op]：arrange 立即重排、raise 全部提到最前、pause 暂停、resume 恢复 */
    fun tile(op: String) {
        if (!sendHostCommand(op, InputEvents.tile(op))) return
        when (op) {
            "arrange" -> toast("已让电脑重排窗口")
            "raise" -> toast("已把所有会话窗口提到最前")
        }
    }

    /** 锁定电脑。只在用户明确点了才发；断开连接不会锁定 */
    fun lockPc() {
        sendHostCommand("lock", InputEvents.lockNow())
    }

    /** 把用户这次输入的 Windows 密码或 PIN 发给电脑解锁。密码不保存 */
    fun unlockPc(password: String) {
        if (password.isEmpty() || _state.value.unlocking) return
        val s = peer?.takeIf { it.inputOpen }
        // 连着画面：密码走数据通道，端到端加密。没连画面：用电脑给的公钥加密后经服务器转发（协议文档 2.9）
        val waiter = if (s != null) unlockViaPeer(s, password) else unlockViaServer(password)
        if (waiter == null) return
        update { it.copy(unlocking = true) }
        scope.launch {
            try {
                val code = withTimeoutOrNull(UNLOCK_REPLY_TIMEOUT_MS) { waiter.await() }
                toast(HostCommands.unlockText(code) ?: errorText(code.orEmpty()))
            } finally {
                unlockWaiters.values.remove(waiter)
                hostCmdWaiters.values.remove(waiter)
                update { it.copy(unlocking = false) }
            }
        }
    }

    private fun unlockViaPeer(s: PeerSession, password: String): CompletableDeferred<String>? {
        val id = "u" + java.lang.Long.toString(System.nanoTime() and 0xffffffffffL, 36)
        if (!s.sendInput(InputEvents.unlock(id, password))) {
            toast(NOT_READY)
            return null
        }
        return CompletableDeferred<String>().also { unlockWaiters[id] = it }
    }

    private fun unlockViaServer(password: String): CompletableDeferred<String>? {
        val host = hostCommandTarget() ?: return null
        val key = hostStates[host]?.key
        if (key == null) {
            toast("电脑上的被控端刚启动，还没准备好，过几秒再试")
            return null
        }
        val enc = when (val r = UnlockCipher.encrypt(key, password)) {
            is UnlockCipher.Result.Ok -> r.enc
            UnlockCipher.Result.TooLong -> {
                toast("密码太长，在这里发不了。请打开一个会话窗口，在画面页解锁")
                return null
            }
            UnlockCipher.Result.Failed -> {
                toast("没能加密密码。请打开一个会话窗口，在画面页解锁")
                return null
            }
        }
        val req = "u${++hostCmdSeq}"
        if (!signaling.send(Protocol.hostCmd(host, "unlock", req, enc))) {
            toast("这台电脑不在线")
            return null
        }
        return CompletableDeferred<String>().also { hostCmdWaiters[req] = it }
    }

    // ------------------------------------------------------------------ "全部会话"里折叠环境

    /** 点环境那一行：折叠或展开它下面的会话，记在本机 */
    fun toggleGroup(key: String) {
        val next = _state.value.collapsedGroups.let { if (key in it) it - key else it + key }
        update { it.copy(collapsedGroups = next) }
        scope.launch { store.saveCollapsedGroups(next) }
    }

    // ------------------------------------------------------------------ 设置与统计

    fun updateSettings(transform: (AppSettings) -> AppSettings) {
        val next = transform(_state.value.settings)
        update { it.copy(settings = next) }
        scope.launch { store.saveSettings(next) }
        startStats()
        syncBackgroundService()
    }

    private fun startStats() {
        statsJob?.cancel()
        if (!_state.value.settings.showStats || peer == null) {
            _stats.value = null
            return
        }
        statsJob = scope.launch {
            while (isActive) {
                peer?.getStats { report -> _stats.value = statsReader.read(report) }
                delay(1000)
            }
        }
    }

    // ------------------------------------------------------------------ 工具

    private inline fun update(transform: (AppState) -> AppState) {
        _state.value = transform(_state.value)
    }

    private fun toast(text: String) {
        _messages.tryEmit(text)
    }

    private fun errorText(code: String): String = when (code) {
        "front-failed" -> "电脑上无法把该窗口切到前台"
        "locked" -> "电脑锁屏了，解锁后才能操作"
        "not-locked" -> "电脑没有锁屏"
        "no-service" -> "电脑上没装解锁服务"
        "bad-service" -> "电脑上的解锁服务要重新安装（版本太旧或没通过核实）"
        "rate-limited" -> "失败次数太多，15 分钟后再试"
        "still-locked" -> "没解开，请检查密码或 PIN"
        "no-logon-screen" -> "没找到电脑的登录界面，没有输入密码"
        "busy" -> "正在解锁，请稍候"
        "failed" -> "解锁失败"
        "covered" -> "点击位置被电脑上的其它窗口挡住了"
        "window-gone" -> "该窗口已关闭"
        "capture-failed" -> "采集该窗口失败"
        "host-offline" -> "这台电脑不在线"
        "image-too-large" -> "图片太大了"
        "image-bad" -> "图片数据有误，没能粘贴"
        "image-timeout" -> "图片传输中断了"
        "closed" -> "画面连接断开了，图片没有发出去"
        "file-too-large" -> "文件太大了，电脑不收"
        "file-bad" -> "文件传输出错，电脑没有保存"
        "file-timeout" -> "文件传输中断了"
        "disk-full" -> "电脑的磁盘空间不够了"
        "file-failed" -> "电脑上保存文件失败"
        else -> "操作失败（$code）"
    }

    private fun decodeThumb(dataUrl: String?): ImageBitmap? {
        val comma = dataUrl?.indexOf(',') ?: return null
        if (comma < 0) return null
        return runCatching {
            val bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }

    private companion object {
        const val TAG = "RemoteController"
        const val NOT_READY = "还没有连上画面"
        const val INITIAL_BACKOFF_MS = 1000L
        const val MAX_BACKOFF_MS = 10_000L
        const val REFRESH_TIMEOUT_MS = 6000L
        /** 在后台超过这么久，回来时要重新验证身份 */
        const val LOCK_AFTER_MS = 30_000L
        /** 在选图界面里最多保持连接这么久 */
        const val PICK_GRACE_MS = 120_000L
        /** 正在发文件时切到后台，最多再保持连接这么久，等它发完 */
        const val UPLOAD_GRACE_MS = 10 * 60_000L
        const val FILE_CLOSED = "画面连接断开了，文件没有发完"
        const val IMAGE_CHUNK = 16 * 1024
        const val MAX_BUFFERED = 256 * 1024L
        const val IMAGE_REPLY_TIMEOUT_MS = 20_000L
        const val IMAGE_OK = "ok"
        const val UNLOCK_REPLY_TIMEOUT_MS = 30_000L
        /** 电脑上打开会话最慢要等 Claude 启动、再点几级菜单 */
        const val OPEN_TIMEOUT_MS = 60_000L
        /** 自动检查 App 更新的间隔 */
        const val UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000L
    }
}
