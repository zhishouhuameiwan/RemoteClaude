package com.remoteclaude.android.protocol

import com.remoteclaude.android.input.RemotePoint
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 消息样例取自 docs/03-protocol.md（协议版本 2）和服务器的实际输出 */
class ProtocolTest {
    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject
    private fun JsonObject.str(k: String) = getValue(k).jsonPrimitive.content

    @Test
    fun parsesAuthOkWithHostsAndTurnServer() {
        val msg = Protocol.parse(
            """{"type":"auth-ok","role":"viewer","id":"a1b2c3d4e5f6","email":"a@example.com",
               "iceServers":[{"urls":["turn:rc.example.com:3478?transport=udp"],"username":"1794990000","credential":"abc="},
                             {"urls":"stun:rc.example.com:3478"}],
               "hosts":[{"id":"k3J9","name":"办公室电脑","online":true},{"id":"home","name":"家里","online":false},{"name":"缺 id，应忽略"}]}"""
        )
        assertTrue(msg is Incoming.AuthOk)
        msg as Incoming.AuthOk
        assertEquals("a@example.com", msg.email)
        assertEquals(listOf(HostInfo("k3J9", "办公室电脑", true), HostInfo("home", "家里", false)), msg.hosts)
        assertEquals(2, msg.iceServers.size)
        assertEquals("1794990000", msg.iceServers[0].username)
        assertEquals(listOf("stun:rc.example.com:3478"), msg.iceServers[1].urls)
        assertNull(msg.iceServers[1].credential)
    }

    @Test
    fun parsesAuthFailAndHosts() {
        assertEquals(Incoming.AuthFail("revoked"), Protocol.parse("""{"type":"auth-fail","reason":"revoked"}"""))
        assertEquals(
            Incoming.Hosts(listOf(HostInfo("pc", "电脑", false))),
            Protocol.parse("""{"type":"hosts","hosts":[{"id":"pc","name":"","online":false}]}"""),
        )
    }

    @Test
    fun parsesWindowListWithHost() {
        val msg = Protocol.parse(
            """{"type":"windows","host":"pc-1","list":[
                {"hwnd":40571112,"title":"Claude窗口远程控制工具","minimized":false,"width":854,"height":1380,"thumb":"data:image/jpeg;base64,AAAA"},
                {"hwnd":3150534,"title":"已最小化的会话","minimized":true,"width":0,"height":0,"thumb":null},
                {"title":"缺少句柄，应被忽略"}]}"""
        ) as Incoming.Windows
        assertEquals("pc-1", msg.host)
        assertEquals(2, msg.list.size)
        assertEquals(40571112L, msg.list[0].hwnd)
        assertEquals(854, msg.list[0].width)
        assertTrue(msg.list[1].minimized)
        assertNull(msg.list[1].thumb)
        // 一次回完的列表（旧版被控端）没有 thumbs
        assertNull(msg.thumbs)
    }

    @Test
    fun windowListCanArriveBeforeItsThumbnails() {
        // 要列表时告诉被控端缩略图可以后补
        val list = obj(Protocol.list("pc"))
        assertEquals("list", list.str("type"))
        assertEquals("later", list.str("thumbs"))

        // 0.9.7 起的被控端先回不带图的一份，截完图再补一份
        val first = Protocol.parse(
            """{"type":"windows","host":"pc-1","thumbs":"pending","list":[
                {"hwnd":7,"title":"会话","minimized":false,"width":854,"height":1380,"thumb":null,"closable":true}]}"""
        ) as Incoming.Windows
        assertEquals(Protocol.THUMBS_PENDING, first.thumbs)
        assertEquals("会话", first.list[0].title)
        assertNull(first.list[0].thumb)

        val second = Protocol.parse(
            """{"type":"windows","host":"pc-1","thumbs":"done","list":[
                {"hwnd":7,"title":"会话","minimized":false,"width":854,"height":1380,"thumb":"data:image/jpeg;base64,AAAA","closable":true}]}"""
        ) as Incoming.Windows
        assertEquals(Protocol.THUMBS_DONE, second.thumbs)
        assertEquals("data:image/jpeg;base64,AAAA", second.list[0].thumb)
    }

    @Test
    fun parsesHostMessages() {
        val offer = Protocol.parse("""{"type":"offer","host":"h","sdp":{"type":"offer","sdp":"v=0\r\n"},"hwnd":7,"title":"T"}""")
        assertEquals(Incoming.Offer("h", "v=0\r\n", 7, "T"), offer)

        val ice = Protocol.parse("""{"type":"ice","host":"h","candidate":{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0}}""")
        assertEquals(Incoming.Ice("h", IceCandidateSpec("candidate:1 1 udp 1 1.2.3.4 5 typ host", "0", 0)), ice)

        assertEquals(Incoming.Selected("h", 9, "S"), Protocol.parse("""{"type":"selected","host":"h","hwnd":9,"title":"S"}"""))
        assertEquals(Incoming.WindowClosed("h"), Protocol.parse("""{"type":"window-closed","host":"h"}"""))
        assertEquals(Incoming.Error("h", "host-offline"), Protocol.parse("""{"type":"error","code":"host-offline","host":"h"}"""))
    }

    @Test
    fun ignoresUnknownAndMalformed() {
        assertNull(Protocol.parse("""{"type":"something-new"}"""))
        assertNull(Protocol.parse("not json"))
        assertNull(Protocol.parse("""["array"]"""))
        assertNull(Protocol.parse("""{"type":"offer","sdp":"wrong shape"}"""))
    }

    @Test
    fun parsesInputErrorFromDataChannel() {
        assertEquals(InputError("covered", null), Protocol.parseInputError("""{"t":"err","code":"covered"}"""))
        assertEquals(InputError("unknown", null), Protocol.parseInputError("""{"t":"err"}"""))
        assertNull(Protocol.parseInputError("""{"t":"m","x":0.5,"y":0.5}"""))
    }

    @Test
    fun inputErrorCarriesHostDetail() {
        val e = Protocol.parseInputError("""{"t":"err","code":"front-failed","detail":"最前面是管理员权限的「任务管理器」（taskmgr.exe）"}""")
        assertEquals(InputError("front-failed", "最前面是管理员权限的「任务管理器」（taskmgr.exe）"), e)
        assertEquals("电脑上无法把该窗口切到前台：最前面是管理员权限的「任务管理器」（taskmgr.exe）", e?.withDetail("电脑上无法把该窗口切到前台"))
        // 没有说明（旧版被控端）时提示不变
        assertEquals("该窗口已关闭", InputError("window-gone", null).withDetail("该窗口已关闭"))
    }

    @Test
    fun inputErrorDetailIsCleaned() {
        // 控制字符去掉、首尾空白去掉，空的当作没有，不是字符串的不认
        assertEquals("ab", Protocol.parseInputError("""{"t":"err","code":"x","detail":"  a\nb\u0007\u0085 "}""")?.detail)
        assertNull(Protocol.parseInputError("""{"t":"err","code":"x","detail":"   "}""")?.detail)
        assertNull(Protocol.parseInputError("""{"t":"err","code":"x","detail":12}""")?.detail)
        // 太长的截掉
        val long = "字".repeat(Protocol.DETAIL_MAX + 50)
        assertEquals(Protocol.DETAIL_MAX, Protocol.parseInputError("""{"t":"err","code":"x","detail":"$long"}""")?.detail?.length)
    }

    @Test
    fun buildsAuthAndSignalingMessages() {
        val auth = obj(Protocol.auth("tok"))
        assertEquals("auth", auth.str("type"))
        assertEquals("viewer", auth.str("role"))
        assertEquals("tok", auth.str("token"))
        assertEquals(2, auth.getValue("proto").jsonPrimitive.int)
        assertTrue(auth.str("client").startsWith("android/"))

        assertEquals("pc", obj(Protocol.list("pc")).str("host"))
        val select = obj(Protocol.select("pc", 40571112L))
        assertEquals("pc", select.str("host"))
        assertEquals(40571112L, select.getValue("hwnd").jsonPrimitive.long)
        assertEquals("pc", obj(Protocol.stop("pc")).str("host"))

        val answer = obj(Protocol.answer("pc", "v=0\r\na=x\r\n"))
        assertEquals("pc", answer.str("host"))
        assertEquals("answer", answer.getValue("sdp").jsonObject.str("type"))
        assertEquals("v=0\r\na=x\r\n", answer.getValue("sdp").jsonObject.str("sdp"))

        val ice = obj(Protocol.ice("pc", IceCandidateSpec("candidate:x", "0", 0)))
        assertEquals("pc", ice.str("host"))
        assertEquals("candidate:x", ice.getValue("candidate").jsonObject.str("candidate"))
    }

    @Test
    fun inputEventsMatchProtocol() {
        val p = RemotePoint(0.123456789, 0.5)
        val click = obj(InputEvents.down(p, InputEvents.BUTTON_RIGHT))
        assertEquals("d", click.str("t"))
        assertEquals("0.12346", click.str("x"))
        assertEquals(2, click.getValue("b").jsonPrimitive.int)

        val wheel = obj(InputEvents.wheel(p, 0, -120))
        assertEquals(-120, wheel.getValue("dy").jsonPrimitive.int)

        val key = obj(InputEvents.key("Enter", InputEvents.MOD_SHIFT))
        assertEquals("Enter", key.str("k"))
        assertEquals(2, key.getValue("m").jsonPrimitive.int)
    }

    @Test
    fun textEventKeepsChineseEmojiAndNewlines() {
        val s = "你好，Claude! abc 123 😀\n第二行"
        assertEquals(s, obj(InputEvents.text(s)).str("s"))
    }

    @Test
    fun imageMessagesMatchSection45() {
        val begin = obj(InputEvents.imageBegin("k3f9a2", "image/jpeg", 345678))
        assertEquals("img", begin.str("t"))
        assertEquals("k3f9a2", begin.str("id"))
        assertEquals("image/jpeg", begin.str("mime"))
        assertEquals(345678, begin.getValue("size").jsonPrimitive.int)
        val end = obj(InputEvents.imageEnd("k3f9a2"))
        assertEquals("img-end", end.str("t"))
        assertEquals("k3f9a2", end.str("id"))
    }

    @Test
    fun fileMessagesMatchSection48() {
        val begin = obj(InputEvents.fileBegin("f1a2", "季度报告 v2.pdf", 123_456_789L))
        assertEquals("file", begin.str("t"))
        assertEquals("f1a2", begin.str("id"))
        assertEquals("季度报告 v2.pdf", begin.str("name"))
        assertEquals(123_456_789L, begin.getValue("size").jsonPrimitive.long)
        val end = obj(InputEvents.fileEnd("f1a2", "ab".repeat(32)))
        assertEquals("file-end", end.str("t"))
        assertEquals("f1a2", end.str("id"))
        assertEquals("ab".repeat(32), end.str("sha256"))
        val cancel = obj(InputEvents.fileCancel("f1a2"))
        assertEquals("file-cancel", cancel.str("t"))
        assertEquals("f1a2", cancel.str("id"))
    }

    @Test
    fun parsesFileRepliesAndCaps() {
        assertEquals(
            FileReply("f1", "C:\\Users\\a\\Downloads\\RemoteClaude\\x (1).pdf", "x (1).pdf", true, null),
            Protocol.parseFileReply(
                """{"t":"file-ok","id":"f1","path":"C:\\Users\\a\\Downloads\\RemoteClaude\\x (1).pdf","name":"x (1).pdf","pasted":true}""",
            ),
        )
        // 存下了但没粘贴上
        assertEquals(
            FileReply("f1", "C:\\d\\x.pdf", "x.pdf", false, "locked"),
            Protocol.parseFileReply("""{"t":"file-ok","id":"f1","path":"C:\\d\\x.pdf","name":"x.pdf","pasted":false,"code":"locked"}"""),
        )
        assertEquals(FileReply("f1", null, null, false, "disk-full"), Protocol.parseFileReply("""{"t":"err","code":"disk-full","id":"f1"}"""))
        assertNull(Protocol.parseFileReply("""{"t":"file-ok","id":"f1"}"""))
        assertNull(Protocol.parseFileReply("""{"t":"err","code":"covered"}"""))

        assertEquals(52_428_800L, Protocol.parseFileCaps("""{"t":"file-caps","max":52428800}"""))
        assertNull(Protocol.parseFileCaps("""{"t":"file-caps"}"""))
        assertNull(Protocol.parseFileCaps("""{"t":"tile-state","available":true}"""))
        // 输入通道上的其它解析不会把 file-caps 当成自己的消息
        val caps = """{"t":"file-caps","max":52428800}"""
        assertNull(Protocol.parseImageReply(caps))
        assertNull(Protocol.parseInputError(caps))
        assertNull(Protocol.parseLockState(caps))
    }

    @Test
    fun parsesImageReplies() {
        assertEquals(ImageReply("k3f9a2", null), Protocol.parseImageReply("""{"t":"img-ok","id":"k3f9a2"}"""))
        assertEquals(
            ImageReply("k3f9a2", "image-bad"),
            Protocol.parseImageReply("""{"t":"err","code":"image-bad","id":"k3f9a2"}"""),
        )
        // 不带 id 的错误是普通输入错误，交给 parseInputError
        assertNull(Protocol.parseImageReply("""{"t":"err","code":"covered"}"""))
        assertNull(Protocol.parseImageReply("""{"t":"img-ok"}"""))
    }

    @Test
    fun lockAndUnlockMessagesMatchSection46() {
        assertEquals(LockState(locked = true, unlockAvailable = false), Protocol.parseLockState("""{"t":"lock","locked":true,"unlock":false}"""))
        assertEquals(LockState(locked = false, unlockAvailable = true), Protocol.parseLockState("""{"t":"lock","locked":false,"unlock":true}"""))
        // 解锁服务核实不过（旧版要重新安装）：和"没装"分开；能解锁时 untrusted 不算数
        assertEquals(
            LockState(locked = true, unlockAvailable = false, unlockUntrusted = true),
            Protocol.parseLockState("""{"t":"lock","locked":true,"unlock":false,"untrusted":true}"""),
        )
        assertEquals(
            LockState(locked = true, unlockAvailable = true, unlockUntrusted = false),
            Protocol.parseLockState("""{"t":"lock","locked":true,"unlock":true,"untrusted":true}"""),
        )
        assertNull(Protocol.parseLockState("""{"t":"err","code":"locked"}"""))

        assertEquals(UnlockResult("u1", null), Protocol.parseUnlockResult("""{"t":"unlock-result","id":"u1","ok":true}"""))
        assertEquals(
            UnlockResult("u1", "still-locked"),
            Protocol.parseUnlockResult("""{"t":"unlock-result","id":"u1","ok":false,"code":"still-locked"}"""),
        )
        // 解锁回执不能被当成图片回执
        assertNull(Protocol.parseImageReply("""{"t":"unlock-result","id":"u1","ok":true}"""))

        assertEquals(TileState(available = true, paused = true), Protocol.parseTileState("""{"t":"tile-state","available":true,"paused":true}"""))
        assertNull(Protocol.parseTileState("""{"t":"lock","locked":true}"""))
        val tile = obj(InputEvents.tile("arrange"))
        assertEquals("tile", tile.str("t"))
        assertEquals("arrange", tile.str("op"))

        assertEquals("lock-now", obj(InputEvents.lockNow()).str("t"))
        val unlock = obj(InputEvents.unlock("u1", "p@ss 中文\"引号"))
        assertEquals("unlock", unlock.str("t"))
        assertEquals("u1", unlock.str("id"))
        assertEquals("p@ss 中文\"引号", unlock.str("p"))
    }

    @Test
    fun approvalMessagesMatchSection27() {
        val list = Protocol.parse(
            """{"type":"approvals","host":"pc-1","list":[
              {"id":"aaaa","kind":"permission","title":"会话","cwd":"F:\\p","agent":"","tool":"Bash","description":"删目录",
               "params":[{"key":"command","value":"rm -rf build"}],"complete":false,"questions":[],"createdAt":5},
              {"id":"bbbb","kind":"ask","title":"t","questions":[{"question":"选哪个？","header":"方案","multiSelect":true,
               "options":[{"label":"A","description":"甲"}]}]},
              {"kind":"ask"}]}""",
        ) as Incoming.Approvals
        assertEquals("pc-1", list.host)
        assertEquals(2, list.list.size)
        val p = list.list[0]
        assertEquals(false, p.isAsk)
        assertEquals(listOf(ApprovalParam("command", "rm -rf build")), p.params)
        assertEquals(false, p.complete)
        assertEquals(5L, p.createdAt)
        val q = list.list[1]
        assertTrue(q.isAsk)
        assertEquals(ApprovalQuestion("选哪个？", "方案", true, listOf(ApprovalOption("A", "甲"))), q.questions[0])

        val allow = obj(Protocol.approvalAnswer("pc-1", "aaaa", "r1", "allow", "", null))
        assertEquals("approval-answer", allow.str("type"))
        assertEquals("allow", allow.str("choice"))
        assertTrue("answers" !in allow)
        val ans = obj(Protocol.approvalAnswer("pc-1", "bbbb", "r2", "allow", "", mapOf("单选？" to "A", "多选？" to listOf("甲", "乙"))))
        val answers = ans.getValue("answers").jsonObject
        assertEquals("A", answers.getValue("单选？").jsonPrimitive.content)
        assertEquals(listOf("甲", "乙"), (answers.getValue("多选？") as kotlinx.serialization.json.JsonArray).map { it.jsonPrimitive.content })

        assertEquals(
            Incoming.ApprovalResult("pc-1", "aaaa", "r1", false, "gone"),
            Protocol.parse("""{"type":"approval-result","host":"pc-1","id":"aaaa","req":"r1","ok":false,"code":"gone"}"""),
        )
    }

    @Test
    fun updateMessages() {
        val sha = "a".repeat(64)
        assertEquals(
            AppUpdateInfo("com.remoteclaude.android", 8, "0.7.0", "修了些问题", 1234L, sha, "/download/android/RemoteClaude-0.7.0.apk"),
            Protocol.parseAppUpdate(
                """{"package":"com.remoteclaude.android","versionCode":8,"versionName":"0.7.0","notes":"修了些问题","size":1234,"sha256":"${sha.uppercase()}","url":"/download/android/RemoteClaude-0.7.0.apk"}""",
            ),
        )
        // 没有哈希、地址不是本服务器的下载路径，都不认
        assertNull(Protocol.parseAppUpdate("""{"package":"p","versionCode":8,"url":"/download/android/x.apk"}"""))
        assertNull(Protocol.parseAppUpdate("""{"package":"p","versionCode":8,"sha256":"$sha","url":"https://evil.example/x.apk"}"""))
        assertNull(Protocol.parseAppUpdate("""{"versionCode":8,"sha256":"$sha","url":"/download/android/x.apk"}"""))

        val op = obj(Protocol.hostUpdate("pc-1", "install"))
        assertEquals("host-update", op.str("type"))
        assertEquals("install", op.str("op"))
        assertEquals(
            Incoming.HostUpdate("pc-1", HostUpdateState("0.7.0", "downloading", "0.7.1", 35)),
            Protocol.parse("""{"type":"host-update-state","host":"pc-1","version":"0.7.0","status":"downloading","newVersion":"0.7.1","percent":35}"""),
        )
    }

    @Test
    fun sessionMessagesMatchSection25() {
        val list = obj(Protocol.listSessions("pc-1"))
        assertEquals("list-sessions", list.str("type"))
        assertEquals("pc-1", list.str("host"))
        val open = obj(Protocol.openSession("pc-1", "local_ab-12", "s1"))
        assertEquals("open-session", open.str("type"))
        assertEquals("local_ab-12", open.str("session"))
        assertEquals("s1", open.str("req"))
        val create = obj(Protocol.newSession("pc-1", "env-9", "s2"))
        assertEquals("new-session", create.str("type"))
        assertEquals("env-9", create.str("env"))
        assertEquals("s2", create.str("req"))

        val sessions = Protocol.parse(
            """{"type":"sessions","host":"pc-1","available":true,"groups":[
              {"key":"env:e1","name":"RemoteClaude","folder":"F:\\SVN\\RC","env":"e1","sessions":[
                {"id":"local_1","title":"远程控制","at":1795051127204,"open":true},{"title":"缺 id 的跳过"}]},
              {"key":"dir:x","name":"GitProjects","folder":"E:\\Git","env":null,"sessions":[]},
              {"name":"缺 key 的组跳过"}]}""",
        ) as Incoming.Sessions
        assertEquals("pc-1", sessions.host)
        assertTrue(sessions.available)
        assertEquals(
            listOf(
                SessionGroup("env:e1", "RemoteClaude", "F:\\SVN\\RC", "e1", listOf(SessionEntry("local_1", "远程控制", 1795051127204L, true))),
                SessionGroup("dir:x", "GitProjects", "E:\\Git", null, emptyList()),
            ),
            sessions.groups,
        )
        val none = Protocol.parse("""{"type":"sessions","host":"pc-1","available":false,"reason":"no-claude","groups":[]}""") as Incoming.Sessions
        assertEquals("no-claude", none.reason)

        assertEquals(
            Incoming.SessionOpened("pc-1", "s2", 42L, "新会话", created = true, envOk = false),
            Protocol.parse("""{"type":"session-opened","host":"pc-1","req":"s2","hwnd":42,"title":"新会话","created":true,"envOk":false}"""),
        )
        // 打开已有会话的回执不带 envOk，当作选好了
        assertEquals(
            Incoming.SessionOpened("pc-1", "s1", 7L, "t", created = false, envOk = true),
            Protocol.parse("""{"type":"session-opened","host":"pc-1","req":"s1","hwnd":7,"title":"t","created":false}"""),
        )
        assertNull(Protocol.parse("""{"type":"session-opened","host":"pc-1","req":"s1"}"""))
        assertEquals(
            Incoming.SessionFailed("pc-1", "s1", "locked"),
            Protocol.parse("""{"type":"session-failed","host":"pc-1","req":"s1","code":"locked"}"""),
        )
    }

    @Test
    fun closeWindowMessages() {
        // 0.9.1 起的被控端在窗口列表里标出能不能关；旧版本没有这个字段，解析成 null
        val list = Protocol.parse(
            """{"type":"windows","host":"pc-1","list":[
                {"hwnd":1,"title":"Claude","minimized":false,"width":900,"height":700,"thumb":null,"closable":false},
                {"hwnd":2,"title":"通知声音提醒功能","minimized":false,"width":850,"height":1391,"thumb":null,"closable":true},
                {"hwnd":3,"title":"旧被控端","minimized":false,"width":850,"height":1391,"thumb":null}]}"""
        ) as Incoming.Windows
        assertEquals(listOf(false, true, null), list.list.map { it.closable })

        val close = obj(Protocol.closeWindow("pc-1", 4524954L, "已打开卡片加关闭按钮", "c3"))
        assertEquals("close-window", close.str("type"))
        assertEquals("pc-1", close.str("host"))
        assertEquals(4524954L, close.getValue("hwnd").jsonPrimitive.long)
        assertEquals("已打开卡片加关闭按钮", close.str("title"))
        assertEquals("c3", close.str("req"))

        assertEquals(
            Incoming.CloseWindowResult("pc-1", "c3", 4524954L, ok = true, code = ""),
            Protocol.parse("""{"type":"close-window-result","host":"pc-1","req":"c3","hwnd":4524954,"ok":true}"""),
        )
        assertEquals(
            Incoming.CloseWindowResult("pc-1", "c4", 9L, ok = false, code = "changed"),
            Protocol.parse("""{"type":"close-window-result","host":"pc-1","req":"c4","hwnd":9,"ok":false,"code":"changed"}"""),
        )
        // 失败却没给原因的，当作 failed
        assertEquals(
            Incoming.CloseWindowResult("pc-1", "c5", 0L, ok = false, code = "failed"),
            Protocol.parse("""{"type":"close-window-result","host":"pc-1","req":"c5","ok":false}"""),
        )
    }

    @Test
    fun hostStateAndCommandsMatchSection29() {
        assertEquals(
            Incoming.HostStatePush(
                "pc-1",
                HostState(LockState(locked = true, unlockAvailable = true), TileState(available = true, paused = false), key = "MIIB"),
            ),
            Protocol.parse(
                """{"type":"host-state","host":"pc-1","lock":{"locked":true,"unlock":true},"tile":{"available":true,"paused":false},"key":"MIIB"}"""
            ),
        )
        // 被控端刚启动、公钥还没生成好时不带 key；缺的字段都当 false
        assertEquals(
            Incoming.HostStatePush("pc-1", HostState(LockState(false, false), TileState(available = false, paused = false), key = null)),
            Protocol.parse("""{"type":"host-state","host":"pc-1","lock":{"locked":false},"key":""}"""),
        )
        assertEquals(
            TileState(available = false, paused = true),
            (Protocol.parse("""{"type":"host-state","host":"pc-1","tile":{"paused":true}}""") as Incoming.HostStatePush).state.tile,
        )

        val arrange = obj(Protocol.hostCmd("pc-1", "arrange"))
        assertEquals(setOf("type", "host", "op"), arrange.keys)
        assertEquals("host-cmd", arrange.str("type"))
        assertEquals("pc-1", arrange.str("host"))
        assertEquals("arrange", arrange.str("op"))
        val unlock = obj(Protocol.hostCmd("pc-1", "unlock", req = "u1", enc = "QUJD"))
        assertEquals(listOf("unlock", "u1", "QUJD"), listOf(unlock.str("op"), unlock.str("req"), unlock.str("enc")))

        assertEquals(
            Incoming.HostCmdResult("pc-1", "u1", "unlock", ok = true, code = ""),
            Protocol.parse("""{"type":"host-cmd-result","host":"pc-1","req":"u1","op":"unlock","ok":true}"""),
        )
        assertEquals(
            Incoming.HostCmdResult("pc-1", "u2", "unlock", ok = false, code = "still-locked"),
            Protocol.parse("""{"type":"host-cmd-result","host":"pc-1","req":"u2","op":"unlock","ok":false,"code":"still-locked"}"""),
        )
        assertEquals(
            Incoming.HostCmdResult("pc-1", "u3", "", ok = false, code = "failed"),
            Protocol.parse("""{"type":"host-cmd-result","host":"pc-1","req":"u3","ok":false}"""),
        )
    }
}
