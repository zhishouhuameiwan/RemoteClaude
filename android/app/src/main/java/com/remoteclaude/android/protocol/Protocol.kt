package com.remoteclaude.android.protocol

import com.remoteclaude.android.BuildConfig
import com.remoteclaude.android.input.RemotePoint
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.math.roundToLong

/**
 * 与信令服务器、被控端之间的消息格式。全部约定见 docs/03-protocol.md（协议版本 2）。
 * 这个文件不依赖 Android，可以直接做 JVM 单元测试。
 */

const val PROTOCOL_VERSION = 2

val CLIENT_NAME: String = "android/${BuildConfig.VERSION_NAME}"

data class IceServerSpec(val urls: List<String>, val username: String?, val credential: String?)

/** ICE 候选。注意 JSON 里叫 candidate，对应安卓 IceCandidate 的 sdp 字段。 */
data class IceCandidateSpec(val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int)

/** 账号下的一台电脑（被控端） */
data class HostInfo(val id: String, val name: String, val online: Boolean)

data class RemoteWindow(
    val hwnd: Long,
    val title: String,
    val minimized: Boolean,
    val width: Int,
    val height: Int,
    /** JPEG 缩略图的 data URL，取不到时为 null */
    val thumb: String?,
    /**
     * 能不能从手机关掉这个窗口（协议文档 2.8，被控端 0.9.1 起）：Claude 主窗口为 false。
     * 为 null 表示被控端是旧版本，不认关闭窗口的请求
     */
    val closable: Boolean? = null,
)

/** 电脑上 Claude 桌面端的一个会话（协议文档 2.5）；[open] 表示已经开成了单独窗口 */
data class SessionEntry(val id: String, val title: String, val at: Long, val open: Boolean)

/** 一组会话：一个环境，或者一个没有对应环境的工作目录（[env] 为 null，不能在这组里新建） */
data class SessionGroup(
    val key: String,
    val name: String,
    val folder: String,
    val env: String?,
    val sessions: List<SessionEntry>,
)

/** 服务器上发布的最新安卓安装包（docs/08）；[url] 是相对服务器的下载路径 */
data class AppUpdateInfo(
    /** 安装包的包名；只认和本 App 一样的（调试版和正式版包名不同） */
    val packageName: String,
    val versionCode: Int,
    val versionName: String,
    val notes: String,
    val size: Long,
    val sha256: String,
    val url: String,
)

/**
 * 电脑被控端的版本和升级状态（协议文档 2.6）。[status]：dev 从源码运行、不自动升级；idle 还没查；checking；
 * latest 已是最新；downloading 正在下载 [newVersion]（[percent]%）；ready 已下好，没人看画面时自动升级；installing；error
 */
data class HostUpdateState(val version: String, val status: String, val newVersion: String, val percent: Int)

/** 电脑上等手机作答的一条审批或提问（协议文档 2.7，docs/09） */
data class Approval(
    val id: String,
    /** permission：审批工具调用；ask：Claude 的提问 */
    val kind: String,
    /** 会话名 */
    val title: String,
    val cwd: String,
    /** 来自子代理时是子代理类型，否则为空 */
    val agent: String,
    val tool: String,
    /** Bash 一类工具里 Claude 自己写的说明 */
    val description: String,
    val params: List<ApprovalParam>,
    /** 为 false 表示有参数太长被截掉了 */
    val complete: Boolean,
    val questions: List<ApprovalQuestion>,
    val createdAt: Long,
) {
    val isAsk: Boolean get() = kind == "ask"
}

data class ApprovalParam(val key: String, val value: String)

data class ApprovalQuestion(val question: String, val header: String, val multiSelect: Boolean, val options: List<ApprovalOption>)

data class ApprovalOption(val label: String, val description: String)

/** 从信令通道收到的消息。电脑发来的消息都带 host，表示来自哪台电脑 */
sealed interface Incoming {
    data class AuthOk(
        val id: String,
        val email: String,
        val iceServers: List<IceServerSpec>,
        val hosts: List<HostInfo>,
    ) : Incoming

    data class AuthFail(val reason: String) : Incoming
    data class Hosts(val hosts: List<HostInfo>) : Incoming
    /**
     * [thumbs]：被控端 0.9.7 起把窗口列表分两次回（协议文档 2.4）。[Protocol.THUMBS_PENDING] 是先到的那份，
     * 不带缩略图；[Protocol.THUMBS_DONE] 是随后补的带图的那份。为 null 是一次回完的（旧版被控端，或关窗口后推来的）
     */
    data class Windows(val host: String, val list: List<RemoteWindow>, val thumbs: String? = null) : Incoming
    data class Offer(val host: String, val sdp: String, val hwnd: Long, val title: String) : Incoming
    data class Ice(val host: String, val candidate: IceCandidateSpec) : Incoming
    data class Selected(val host: String, val hwnd: Long, val title: String) : Incoming
    data class WindowClosed(val host: String) : Incoming
    data class Error(val host: String, val code: String) : Incoming

    /** 会话目录；[available] 为 false 时 [reason] 说明原因（比如电脑上没装 Claude 桌面端） */
    data class Sessions(val host: String, val available: Boolean, val reason: String?, val groups: List<SessionGroup>) : Incoming

    /** 会话窗口已经在电脑上开好（或本来就开着），接着 select 它；[envOk] 为 false 表示新建时没能自动选上环境 */
    data class SessionOpened(
        val host: String,
        val req: String,
        val hwnd: Long,
        val title: String,
        val created: Boolean,
        val envOk: Boolean,
    ) : Incoming

    data class SessionFailed(val host: String, val req: String, val code: String) : Incoming

    /** 关闭窗口的回执（协议文档 2.8）；[ok] 为 false 时 [code] 说明原因 */
    data class CloseWindowResult(val host: String, val req: String, val hwnd: Long, val ok: Boolean, val code: String) : Incoming

    data class HostUpdate(val host: String, val state: HostUpdateState) : Incoming

    /** 这台电脑上全部等待中的审批 */
    data class Approvals(val host: String, val list: List<Approval>) : Incoming

    data class ApprovalResult(val host: String, val id: String, val req: String, val ok: Boolean, val code: String) : Incoming

    /** 电脑经信令通道推来的锁屏、平铺状态（协议文档 2.9）：没在看画面的控制端也收得到 */
    data class HostStatePush(val host: String, val state: HostState) : Incoming

    /** 不连画面的命令的回执（协议文档 2.9），带了 req 的命令才有；[ok] 为 false 时 [code] 说明原因 */
    data class HostCmdResult(val host: String, val req: String, val op: String, val ok: Boolean, val code: String) : Incoming
}

object Protocol {
    private val json = Json { ignoreUnknownKeys = true }

    /** [Incoming.Windows.thumbs] 的取值 */
    const val THUMBS_PENDING = "pending"
    const val THUMBS_DONE = "done"

    /** 解析一条信令消息；格式不对或类型未知时返回 null */
    fun parse(text: String): Incoming? {
        val obj = parseObject(text) ?: return null
        val host = obj.string("host").orEmpty()
        return when (obj.string("type")) {
            "auth-ok" -> Incoming.AuthOk(
                id = obj.string("id").orEmpty(),
                email = obj.string("email").orEmpty(),
                iceServers = parseIceServers(obj["iceServers"]),
                hosts = parseHosts(obj["hosts"]),
            )
            "auth-fail" -> Incoming.AuthFail(obj.string("reason") ?: "unknown")
            "hosts" -> Incoming.Hosts(parseHosts(obj["hosts"]))
            "windows" -> Incoming.Windows(
                host,
                ((obj["list"] as? JsonArray) ?: emptyList()).mapNotNull(::parseWindow),
                obj.string("thumbs"),
            )
            "offer" -> {
                val sdp = (obj["sdp"] as? JsonObject)?.string("sdp") ?: return null
                Incoming.Offer(host, sdp, obj.long("hwnd") ?: 0L, obj.string("title").orEmpty())
            }
            "ice" -> parseCandidate(obj["candidate"])?.let { Incoming.Ice(host, it) }
            "selected" -> Incoming.Selected(host, obj.long("hwnd") ?: 0L, obj.string("title").orEmpty())
            "window-closed" -> Incoming.WindowClosed(host)
            "error" -> Incoming.Error(host, obj.string("code") ?: "unknown")
            "sessions" -> Incoming.Sessions(
                host,
                available = obj.bool("available") == true,
                reason = obj.string("reason"),
                groups = ((obj["groups"] as? JsonArray) ?: emptyList()).mapNotNull(::parseGroup),
            )
            "session-opened" -> {
                val hwnd = obj.long("hwnd") ?: return null
                Incoming.SessionOpened(
                    host,
                    req = obj.string("req").orEmpty(),
                    hwnd = hwnd,
                    title = obj.string("title").orEmpty(),
                    created = obj.bool("created") == true,
                    envOk = obj.bool("envOk") != false,
                )
            }
            "session-failed" -> Incoming.SessionFailed(host, obj.string("req").orEmpty(), obj.string("code") ?: "failed")
            "close-window-result" -> {
                val ok = obj.bool("ok") == true
                Incoming.CloseWindowResult(
                    host,
                    req = obj.string("req").orEmpty(),
                    hwnd = obj.long("hwnd") ?: 0L,
                    ok = ok,
                    code = if (ok) "" else obj.string("code") ?: "failed",
                )
            }
            "approvals" -> Incoming.Approvals(host, ((obj["list"] as? JsonArray) ?: emptyList()).mapNotNull(::parseApproval))
            "approval-result" -> Incoming.ApprovalResult(
                host,
                id = obj.string("id").orEmpty(),
                req = obj.string("req").orEmpty(),
                ok = obj.bool("ok") == true,
                code = obj.string("code").orEmpty(),
            )
            "host-update-state" -> Incoming.HostUpdate(
                host,
                HostUpdateState(
                    version = obj.string("version").orEmpty(),
                    status = obj.string("status") ?: "idle",
                    newVersion = obj.string("newVersion").orEmpty(),
                    percent = obj.long("percent")?.toInt()?.coerceIn(0, 100) ?: 0,
                ),
            )
            "host-state" -> {
                val lock = obj["lock"] as? JsonObject
                val tile = obj["tile"] as? JsonObject
                Incoming.HostStatePush(
                    host,
                    HostState(
                        lock = lockStateOf(lock),
                        tile = TileState(available = tile?.bool("available") == true, paused = tile?.bool("paused") == true),
                        key = obj.string("key")?.ifEmpty { null },
                    ),
                )
            }
            "host-cmd-result" -> {
                val ok = obj.bool("ok") == true
                Incoming.HostCmdResult(
                    host,
                    req = obj.string("req").orEmpty(),
                    op = obj.string("op").orEmpty(),
                    ok = ok,
                    code = if (ok) "" else obj.string("code") ?: "failed",
                )
            }
            else -> null
        }
    }

    /** 解析被控端从数据通道回报的错误 {"t":"err","code":"..."}，不是这类消息时返回 null */
    /**
     * 解析被控端对一张图片的回执（协议文档 4.5）：`img-ok`，或带 `id` 的 `err`。
     * 不是图片回执时返回 null，交给 [parseInputError] 处理。
     */
    fun parseImageReply(text: String): ImageReply? {
        val obj = parseObject(text) ?: return null
        val id = obj.string("id") ?: return null
        return when (obj.string("t")) {
            "img-ok" -> ImageReply(id, null)
            "err" -> ImageReply(id, obj.string("code") ?: "unknown")
            else -> null
        }
    }

    /**
     * 被控端在 file 通道上对一个文件的回执（协议文档 4.8）：`file-ok`（已存下，[FileReply.pasted] 说明路径粘贴上没有），
     * 或带 `id` 的 `err`（没存下）。不是文件回执时返回 null。
     */
    fun parseFileReply(text: String): FileReply? {
        val obj = parseObject(text) ?: return null
        val id = obj.string("id") ?: return null
        return when (obj.string("t")) {
            "file-ok" -> {
                val path = obj.string("path") ?: return null
                val pasted = obj.bool("pasted") == true
                FileReply(id, path, obj.string("name"), pasted, if (pasted) null else obj.string("code") ?: "failed")
            }
            "err" -> FileReply(id, null, null, false, obj.string("code") ?: "unknown")
            else -> null
        }
    }

    /** 被控端能收文件（0.9.0 起），[Long] 是单个文件的大小上限；不是这条消息时返回 null */
    fun parseFileCaps(text: String): Long? {
        val obj = parseObject(text) ?: return null
        if (obj.string("t") != "file-caps") return null
        return obj.long("max")?.takeIf { it > 0 }
    }

    /** 被控端推来的锁屏状态（协议文档 4.6） */
    fun parseLockState(text: String): LockState? {
        val obj = parseObject(text) ?: return null
        if (obj.string("t") != "lock") return null
        return lockStateOf(obj)
    }

    /** host-state 的 lock（协议文档 2.9）、数据通道的 lock 消息（4.6） */
    private fun lockStateOf(o: JsonObject?): LockState {
        val unlock = o?.bool("unlock") == true
        return LockState(
            locked = o?.bool("locked") == true,
            unlockAvailable = unlock,
            unlockUntrusted = !unlock && o?.bool("untrusted") == true,
        )
    }

    /** 被控端的窗口平铺状态（协议文档 4.7） */
    fun parseTileState(text: String): TileState? {
        val obj = parseObject(text) ?: return null
        if (obj.string("t") != "tile-state") return null
        return TileState(available = obj.bool("available") == true, paused = obj.bool("paused") == true)
    }

    /** 被控端对解锁请求的回执；成功时 [UnlockResult.code] 为 null */
    fun parseUnlockResult(text: String): UnlockResult? {
        val obj = parseObject(text) ?: return null
        if (obj.string("t") != "unlock-result") return null
        val id = obj.string("id") ?: return null
        return UnlockResult(id, if (obj.bool("ok") == true) null else obj.string("code") ?: "failed")
    }

    /** 被控端拒绝了一次输入（协议文档第 5 节）；不是这条消息时返回 null */
    fun parseInputError(text: String): InputError? {
        val obj = parseObject(text) ?: return null
        if (obj.string("t") != "err") return null
        return InputError(obj.string("code") ?: "unknown", cleanDetail(obj.string("detail")))
    }

    /** 被控端写的补充说明：去掉控制字符和首尾空白，最多 [DETAIL_MAX] 个字符，空的当作没有 */
    private fun cleanDetail(raw: String?): String? {
        val text = raw?.filterNot { it.isISOControl() }?.trim()?.take(DETAIL_MAX)
        return text?.takeIf { it.isNotEmpty() }
    }

    /** 输入错误的补充说明最多显示这么多个字符 */
    const val DETAIL_MAX = 200

    /** 电脑上新复制的文字的其中一块（协议文档 4.9，被控端 0.9.9 起）；不是这条消息或格式不对时返回 null */
    fun parseClipChunk(text: String): ClipChunk? {
        val obj = parseObject(text) ?: return null
        if (obj.string("t") != "clip") return null
        val id = obj.string("id")?.takeIf { it.isNotEmpty() && it.length <= 32 } ?: return null
        val count = obj.long("n") ?: return null
        val index = obj.long("i") ?: return null
        if (count !in 1..ClipAssembler.MAX_CHUNKS || index !in 0 until count) return null
        val s = obj.string("s") ?: return null
        return ClipChunk(id, index.toInt(), count.toInt(), s)
    }

    /** 电脑上复制了文字但没有发过来（协议文档 4.9），返回原因，目前只有 too-large；不是这条消息时返回 null */
    fun parseClipSkip(text: String): String? {
        val obj = parseObject(text) ?: return null
        return if (obj.string("t") == "clip-skip") obj.string("code") ?: "unknown" else null
    }

    /** 解析任意 JSON 对象，供账号接口使用 */
    fun parseObject(text: String): JsonObject? =
        runCatching { json.parseToJsonElement(text) as? JsonObject }.getOrNull()

    // ------------------------------------------------------------------ 控制端发出的信令

    fun auth(token: String): String = buildJsonObject {
        put("type", "auth")
        put("role", "viewer")
        put("token", token)
        put("proto", PROTOCOL_VERSION)
        put("client", CLIENT_NAME)
    }.toString()

    /**
     * 要窗口列表。带上 thumbs: "later"，告诉被控端缩略图可以后补：0.9.7 起的被控端先回不带图的列表、
     * 截完图再补一份（见 [Incoming.Windows]），标题和个数不用等截图；旧版被控端不认这个字段，照旧一次回完
     */
    fun list(host: String): String = buildJsonObject {
        put("type", "list")
        put("host", host)
        put("thumbs", "later")
    }.toString()

    fun select(host: String, hwnd: Long): String = buildJsonObject {
        put("type", "select")
        put("host", host)
        put("hwnd", hwnd)
    }.toString()

    fun answer(host: String, sdp: String): String = buildJsonObject {
        put("type", "answer")
        put("host", host)
        putJsonObject("sdp") {
            put("type", "answer")
            put("sdp", sdp)
        }
    }.toString()

    fun ice(host: String, c: IceCandidateSpec): String = buildJsonObject {
        put("type", "ice")
        put("host", host)
        putJsonObject("candidate") {
            put("candidate", c.candidate)
            put("sdpMid", c.sdpMid)
            put("sdpMLineIndex", c.sdpMLineIndex)
        }
    }.toString()

    fun stop(host: String): String = buildJsonObject {
        put("type", "stop")
        put("host", host)
    }.toString()

    /**
     * 回答一条审批（协议文档 2.7）：[choice] 是 allow 或 deny；拒绝时 [text] 是说明；
     * 回答提问时 [answers] 是 问题原文 -> 选项（单选、自己填的文字）或选项列表（多选）
     */
    fun approvalAnswer(host: String, id: String, req: String, choice: String, text: String, answers: Map<String, Any>?): String =
        buildJsonObject {
            put("type", "approval-answer")
            put("host", host)
            put("id", id)
            put("req", req)
            put("choice", choice)
            put("text", text)
            if (answers != null) {
                putJsonObject("answers") {
                    for ((q, a) in answers) {
                        when (a) {
                            is String -> put(q, a)
                            is List<*> -> put(q, JsonArray(a.map { JsonPrimitive(it.toString()) }))
                        }
                    }
                }
            }
        }.toString()

    /** 电脑被控端升级：status 只问状态、check 检查更新、install 马上升级（协议文档 2.6） */
    fun hostUpdate(host: String, op: String): String = buildJsonObject {
        put("type", "host-update")
        put("host", host)
        put("op", op)
    }.toString()

    /**
     * 不连画面的命令（协议文档 2.9，被控端 0.9.6 起）。[op]：arrange、raise、pause、resume（窗口平铺）、lock、unlock。
     * 解锁时 [enc] 是用电脑给的公钥加密过的密码（[UnlockCipher]），[req] 用来认回执；别的命令不用回执
     */
    fun hostCmd(host: String, op: String, req: String? = null, enc: String? = null): String = buildJsonObject {
        put("type", "host-cmd")
        put("host", host)
        put("op", op)
        if (req != null) put("req", req)
        if (enc != null) put("enc", enc)
    }.toString()

    /** 解析 GET /api/update/android 的回复；格式不对返回 null */
    fun parseAppUpdate(text: String): AppUpdateInfo? {
        val o = parseObject(text) ?: return null
        val code = o.long("versionCode")?.toInt() ?: return null
        val url = o.string("url")?.takeIf { it.startsWith("/download/") } ?: return null
        val sha = o.string("sha256")?.lowercase()?.takeIf { it.matches(Regex("[0-9a-f]{64}")) } ?: return null
        val pkg = o.string("package") ?: return null
        return AppUpdateInfo(pkg, code, o.string("versionName").orEmpty(), o.string("notes").orEmpty(), o.long("size") ?: 0L, sha, url)
    }

    /** 请求电脑上 Claude 桌面端的环境和会话目录（协议文档 2.5） */
    fun listSessions(host: String): String = buildJsonObject {
        put("type", "list-sessions")
        put("host", host)
    }.toString()

    /** 在电脑上打开一个会话的窗口；[req] 用来认回执 */
    fun openSession(host: String, sessionId: String, req: String): String = buildJsonObject {
        put("type", "open-session")
        put("host", host)
        put("session", sessionId)
        put("req", req)
    }.toString()

    /**
     * 关掉电脑上的一个会话窗口（协议文档 2.8）。带上卡片上的标题：Claude 会复用藏起来的窗口，
     * 句柄已经换成别的会话时电脑不关，回 changed
     */
    fun closeWindow(host: String, hwnd: Long, title: String, req: String): String = buildJsonObject {
        put("type", "close-window")
        put("host", host)
        put("hwnd", hwnd)
        put("title", title)
        put("req", req)
    }.toString()

    /** 在电脑上某个环境下新建会话（开在新窗口里） */
    fun newSession(host: String, envId: String, req: String): String = buildJsonObject {
        put("type", "new-session")
        put("host", host)
        put("env", envId)
        put("req", req)
    }.toString()

    // ------------------------------------------------------------------ 解析辅助

    private fun parseHosts(el: JsonElement?): List<HostInfo> =
        ((el as? JsonArray) ?: emptyList()).mapNotNull { item ->
            val o = item as? JsonObject ?: return@mapNotNull null
            val id = o.string("id") ?: return@mapNotNull null
            HostInfo(id, o.string("name").orEmpty().ifEmpty { "电脑" }, o.bool("online") ?: false)
        }

    private fun parseIceServers(el: JsonElement?): List<IceServerSpec> =
        ((el as? JsonArray) ?: emptyList()).mapNotNull { item ->
            val o = item as? JsonObject ?: return@mapNotNull null
            val urls = when (val u = o["urls"]) {
                is JsonPrimitive -> listOfNotNull(u.takeIf { it.isString }?.content)
                is JsonArray -> u.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
                else -> emptyList()
            }
            if (urls.isEmpty()) null else IceServerSpec(urls, o.string("username"), o.string("credential"))
        }

    private fun parseCandidate(el: JsonElement?): IceCandidateSpec? {
        val o = el as? JsonObject ?: return null
        val candidate = o.string("candidate") ?: return null
        return IceCandidateSpec(candidate, o.string("sdpMid"), o.long("sdpMLineIndex")?.toInt() ?: 0)
    }

    private fun parseApproval(el: JsonElement): Approval? {
        val o = el as? JsonObject ?: return null
        val id = o.string("id") ?: return null
        val list = { key: String -> (o[key] as? JsonArray) ?: JsonArray(emptyList()) }
        return Approval(
            id = id,
            kind = if (o.string("kind") == "ask") "ask" else "permission",
            title = o.string("title").orEmpty(),
            cwd = o.string("cwd").orEmpty(),
            agent = o.string("agent").orEmpty(),
            tool = o.string("tool").orEmpty(),
            description = o.string("description").orEmpty(),
            params = list("params").mapNotNull { p ->
                (p as? JsonObject)?.let { ApprovalParam(it.string("key").orEmpty(), it.string("value").orEmpty()) }
            },
            complete = o.bool("complete") != false,
            questions = list("questions").mapNotNull { q ->
                val qo = q as? JsonObject ?: return@mapNotNull null
                ApprovalQuestion(
                    question = qo.string("question").orEmpty(),
                    header = qo.string("header").orEmpty(),
                    multiSelect = qo.bool("multiSelect") == true,
                    options = ((qo["options"] as? JsonArray) ?: JsonArray(emptyList())).mapNotNull { op ->
                        (op as? JsonObject)?.let { ApprovalOption(it.string("label").orEmpty(), it.string("description").orEmpty()) }
                    },
                )
            },
            createdAt = o.long("createdAt") ?: 0L,
        )
    }

    private fun parseGroup(el: JsonElement): SessionGroup? {
        val o = el as? JsonObject ?: return null
        val key = o.string("key") ?: return null
        val sessions = ((o["sessions"] as? JsonArray) ?: emptyList()).mapNotNull { item ->
            val s = item as? JsonObject ?: return@mapNotNull null
            val id = s.string("id") ?: return@mapNotNull null
            SessionEntry(id, s.string("title").orEmpty(), s.long("at") ?: 0L, s.bool("open") == true)
        }
        return SessionGroup(key, o.string("name").orEmpty(), o.string("folder").orEmpty(), o.string("env")?.ifEmpty { null }, sessions)
    }

    private fun parseWindow(el: JsonElement): RemoteWindow? {
        val o = el as? JsonObject ?: return null
        val hwnd = o.long("hwnd") ?: return null
        return RemoteWindow(
            hwnd = hwnd,
            title = o.string("title").orEmpty(),
            minimized = o.bool("minimized") ?: false,
            width = o.long("width")?.toInt() ?: 0,
            height = o.long("height")?.toInt() ?: 0,
            thumb = o.string("thumb")?.takeIf { it.startsWith("data:image/") },
            closable = o.bool("closable"),
        )
    }
}

fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

fun JsonObject.bool(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

fun JsonObject.long(key: String): Long? {
    val p = (this[key] as? JsonPrimitive)?.takeIf { !it.isString } ?: return null
    return p.longOrNull ?: p.doubleOrNull?.toLong()
}

/**
 * 通过数据通道发给被控端的输入事件，格式见协议文档第 4 节。
 * 坐标保留 5 位小数，足够区分 4K 窗口里的单个像素。
 */
/** 被控端对一张图片的回执；[code] 为 null 表示已经粘贴进去 */
data class ImageReply(val id: String, val code: String?)

/**
 * 被控端拒绝了一次输入。[detail] 是被控端写好的补充说明（被控端 0.9.30 起，比如切不到前台时挡在最前面的是谁），
 * 旧版被控端不发，为 null
 */
data class InputError(val code: String, val detail: String?) {
    /** 按错误码翻好的提示后面接上补充说明 */
    fun withDetail(text: String): String = if (detail == null) text else "$text：$detail"
}

/**
 * 被控端对一个文件的回执。[path] 不为 null 表示文件已经存到电脑上（[name] 是实际存的文件名，同名时会加编号），
 * 这时 [pasted] 说明路径粘贴进输入框没有，没粘贴上时 [code] 是原因；[path] 为 null 表示没存下，[code] 是错误码
 */
data class FileReply(val id: String, val path: String?, val name: String?, val pasted: Boolean, val code: String?)

/**
 * 电脑是否锁屏，[unlockAvailable] 表示电脑上装了解锁服务。
 * [unlockUntrusted]：电脑上有解锁服务，但被控端核实不过它（多半是旧版，要在电脑上重新安装），这时 [unlockAvailable] 是 false
 */
data class LockState(val locked: Boolean, val unlockAvailable: Boolean, val unlockUntrusted: Boolean = false)

data class UnlockResult(val id: String, val code: String?)

/** 电脑上的窗口平铺：[available] 为 false 表示没在运行 */
data class TileState(val available: Boolean, val paused: Boolean)

/**
 * 电脑上新复制的一段文字的其中一块（协议文档 4.9）：一段文字切成 [count] 块按顺序发，[index] 从 0 起，
 * 同一段的各块 [id] 相同。用 [ClipAssembler] 拼回去
 */
data class ClipChunk(val id: String, val index: Int, val count: Int, val text: String)

/**
 * 电脑经信令通道推来的状态（协议文档 2.9，被控端 0.9.6 起）。[key] 是不连画面解锁时加密密码用的公钥
 * （DER 的 Base64），被控端刚启动、还没生成好时为 null
 */
data class HostState(val lock: LockState, val tile: TileState, val key: String?)

object InputEvents {
    const val BUTTON_LEFT = 0
    const val BUTTON_MIDDLE = 1
    const val BUTTON_RIGHT = 2

    const val MOD_CTRL = 1
    const val MOD_SHIFT = 2
    const val MOD_ALT = 4

    private fun round5(v: Double): Double = (v * 100000.0).roundToLong() / 100000.0

    fun move(p: RemotePoint): String = buildJsonObject {
        put("t", "m")
        put("x", round5(p.x))
        put("y", round5(p.y))
    }.toString()

    fun down(p: RemotePoint, button: Int): String = button("d", p, button)

    fun up(p: RemotePoint, button: Int): String = button("u", p, button)

    private fun button(t: String, p: RemotePoint, button: Int): String = buildJsonObject {
        put("t", t)
        put("x", round5(p.x))
        put("y", round5(p.y))
        put("b", button)
    }.toString()

    fun wheel(p: RemotePoint, dx: Int, dy: Int): String = buildJsonObject {
        put("t", "w")
        put("x", round5(p.x))
        put("y", round5(p.y))
        put("dx", dx)
        put("dy", dy)
    }.toString()

    fun key(key: String, mods: Int): String = buildJsonObject {
        put("t", "k")
        put("k", key)
        put("m", mods)
    }.toString()

    fun text(s: String): String = buildJsonObject {
        put("t", "t")
        put("s", s)
    }.toString()

    /** 开始传一张图片，之后是图片字节的二进制帧，最后是 [imageEnd]（协议文档 4.5） */
    fun imageBegin(id: String, mime: String, size: Int): String = buildJsonObject {
        put("t", "img")
        put("id", id)
        put("mime", mime)
        put("size", size)
    }.toString()

    fun imageEnd(id: String): String = buildJsonObject {
        put("t", "img-end")
        put("id", id)
    }.toString()

    /** 开始传一个文件，走 file 通道；之后是文件字节的二进制帧，最后是 [fileEnd]（协议文档 4.8） */
    fun fileBegin(id: String, name: String, size: Long): String = buildJsonObject {
        put("t", "file")
        put("id", id)
        put("name", name)
        put("size", size)
    }.toString()

    /** 文件发完了，[sha256] 是整个文件的 SHA-256（小写十六进制），电脑据此核对 */
    fun fileEnd(id: String, sha256: String): String = buildJsonObject {
        put("t", "file-end")
        put("id", id)
        put("sha256", sha256)
    }.toString()

    /** 不发了，电脑删掉已经收到的部分 */
    fun fileCancel(id: String): String = buildJsonObject {
        put("t", "file-cancel")
        put("id", id)
    }.toString()

    /** 窗口平铺操作：arrange、raise、pause、resume（协议文档 4.7） */
    fun tile(op: String): String = buildJsonObject {
        put("t", "tile")
        put("op", op)
    }.toString()

    /** 锁定电脑，相当于在电脑上按 Win+L（协议文档 4.6） */
    fun lockNow(): String = buildJsonObject { put("t", "lock-now") }.toString()

    /** 解锁：[password] 是用户这次输入的 Windows 密码或 PIN，不保存 */
    fun unlock(id: String, password: String): String = buildJsonObject {
        put("t", "unlock")
        put("id", id)
        put("p", password)
    }.toString()
}
