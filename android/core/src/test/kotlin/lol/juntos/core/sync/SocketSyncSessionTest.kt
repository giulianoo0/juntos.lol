package lol.juntos.core.sync

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import lol.juntos.core.api.ApiException
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.fake.FakeJuntosApi
import lol.juntos.core.model.MediaRegion
import lol.juntos.core.model.PlayState
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.RoomPreview
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class SocketSyncSessionTest {
    @get:Rule val server = MockWebServer()
    private val ends = LinkedBlockingQueue<WebSocket>()
    private val frames = LinkedBlockingQueue<JsonObject>()
    private val sessions = mutableListOf<SyncSession>()
    private val rooms = mutableMapOf("ROOM1" to RoomInfo(id = "ROOM1", status = "ready", mediaGeneration = 1, mediaVersion = 1))
    private lateinit var end: WebSocket

    private val welcome = """{"type":"welcome","memberId":"m1","controllerId":"m1","capability":"cap1",""" +
        """"members":[{"id":"m1","nickname":"Ana"}],"history":[{"author":"Bia","text":"oi"}],""" +
        """"state":{"playing":true,"positionMs":1000,"rate":1,"serverTimeMs":5}}"""

    @Before
    fun upgradeEverySocket() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { ends += webSocket }
                override fun onMessage(webSocket: WebSocket, text: String) { frames += Json.parseToJsonElement(text).jsonObject }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null) }
            })
        }
    }

    @After
    fun closeSessions() = sessions.forEach(SyncSession::close)

    private fun session(
        request: SessionRequest = SessionRequest("ROOM1", "Ana"),
        api: JuntosApi = FakeJuntosApi(rooms),
        timing: SyncTiming = SyncTiming(heartbeatMs = 50, reconnectMinMs = 10, reconnectMaxMs = 40),
    ) = SocketSyncSession(request, server.url("/").toString(), OkHttpClient(), api, timing = timing).also { sessions += it }

    private fun seated(timing: SyncTiming = SyncTiming(heartbeatMs = 50, reconnectMinMs = 10, reconnectMaxMs = 40)): SyncSession {
        val session = session(timing = timing)
        frame("hello")
        end = ends.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("no socket")
        end.send(welcome)
        await(session) { it.door == Door.In }
        return session
    }

    private fun frame(type: String): JsonObject {
        while (true) {
            val next = frames.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("no $type frame")
            if (next["type"]?.jsonPrimitive?.content == type) return next
        }
    }

    private fun await(session: SyncSession, predicate: (SyncState) -> Boolean) =
        runBlocking { withTimeout(5_000) { session.state.first(predicate) } }

    private fun JsonObject.text(key: String) = get(key)?.jsonPrimitive?.content

    @Test
    fun `the hello names the member, the ticket, the device and the android client`() {
        session(SessionRequest("ROOM1", "Ana", ticket = "tkt", ownerToken = "own", avatar = "gato", device = "dev1"))
        val hello = frame("hello")
        assertEquals("Ana", hello.text("nickname"))
        assertEquals("tkt", hello.text("ticket"))
        assertEquals("own", hello.text("ownerToken"))
        assertEquals("gato", hello.text("avatar"))
        assertEquals("dev1", hello.text("device"))
        assertEquals("android", hello.text("client"))
        assertTrue(hello.getValue("clientTimeMs").jsonPrimitive.long > 0)
        assertNull("a first hello asks for no seat", hello["memberId"])
    }

    @Test
    fun `a welcome seats the member with the room's state and chat`() {
        val seated = await(seated()) { it.memberId == "m1" }
        assertTrue(seated.isController)
        assertEquals(Connection.Open, seated.connection)
        assertEquals("cap1", seated.capability)
        assertEquals(listOf("oi"), seated.chat.map { it.text })
        assertEquals(PlayState(playing = true, positionMs = 1_000, rate = 1.0, serverTimeMs = 5), seated.playState)
    }

    @Test
    fun `play and pause go out with the room position`() {
        val session = seated()
        session.play(5_000)
        assertEquals(5_000L, frame("play").getValue("positionMs").jsonPrimitive.long)
        session.pause(6_500)
        val pause = frame("pause")
        assertEquals(6_500L, pause.getValue("positionMs").jsonPrimitive.long)
        assertEquals("1.0", pause.text("rate"))
    }

    @Test
    fun `the room's commands come back as state`() {
        val session = seated()
        end.send("""{"type":"state","state":{"playing":false,"positionMs":42000,"rate":1,"serverTimeMs":9}}""")
        assertEquals(42_000L, await(session) { it.playState?.playing == false }.playState?.positionMs)
    }

    @Test
    fun `chat typed before the welcome goes out right after it`() {
        val session = session()
        session.chat("cheguei")
        frame("hello")
        ends.poll(5, TimeUnit.SECONDS)!!.send(welcome)
        assertEquals("cheguei", frame("chat").text("text"))
    }

    @Test
    fun `a pong sets the clock offset from the round trip`() {
        val session = seated()
        val sentAt = frame("heartbeat").getValue("clientTimeMs").jsonPrimitive.long
        end.send("""{"type":"pong","serverTimeMs":${sentAt + 60_000},"clientTimeMs":$sentAt}""")
        val offset = await(session) { it.serverOffsetMs != 0L }.serverOffsetMs
        assertTrue("offset $offset", offset in 59_000L..60_000L)
    }

    @Test
    fun `a dropped socket comes back and asks for its seat`() {
        val session = seated()
        end.close(1001, "restart")
        val again = frame("hello")
        assertEquals("m1", again.text("memberId"))
        assertEquals("cap1", again.text("capability"))
        ends.poll(5, TimeUnit.SECONDS)!!.send(welcome)
        assertEquals(Connection.Open, await(session) { it.connection == Connection.Open }.connection)
    }

    @Test
    fun `a socket whose heartbeats go unanswered is given up and replaced`() {
        seated(SyncTiming(heartbeatMs = 50, deadAfterMs = 200, reconnectMinMs = 10, reconnectMaxMs = 40))
        assertEquals("m1", frame("hello").text("memberId"))
    }

    @Test
    fun `being kicked ends the session for good`() {
        val session = seated()
        end.send("""{"type":"error","error":"kicked"}""")
        val ended = await(session) { it.connection == Connection.Closed }
        assertEquals(SyncEvent.Kicked, ended.ended)
    }

    @Test
    fun `a password room stops at the door`() {
        val session = session()
        frame("hello")
        ends.poll(5, TimeUnit.SECONDS)!!.send("""{"type":"error","error":"password_required"}""")
        assertEquals(Door.Password, await(session) { it.door != Door.Joining }.door)
    }

    @Test
    fun `leaving says goodbye before the socket closes`() {
        val session = seated()
        session.leave()
        frame("leave")
        await(session) { it.connection == Connection.Closed }
    }

    @Test
    fun `a publish patches the room's regions in place`() {
        val session = seated()
        await(session) { it.room != null }
        end.send(
            """{"type":"roomUpdated","media":{"mediaGeneration":1,"mediaVersion":2,"mediaOffsetMs":0,""" +
                """"mediaRegions":[{"n":0,"startMs":0,"producedMs":4000,"growing":true}]}}""",
        )
        val patched = await(session) { it.room?.mediaVersion == 2 }
        assertEquals(listOf(MediaRegion(0, 0, 4_000, growing = true)), patched.room?.mediaRegions)
    }

    @Test
    fun `a knock waits for the controller, and an answer clears it`() {
        val session = seated()
        end.send("""{"type":"knock","requestId":"req1","nickname":"Bia"}""")
        assertEquals(listOf(Knock("req1", "Bia")), await(session) { it.knocks.isNotEmpty() }.knocks)
        session.admit("req1")
        assertEquals("req1", frame("admit").text("targetId"))
        await(session) { it.knocks.isEmpty() }
    }

    @Test
    fun `coming back to the network skips the backoff`() {
        val session = seated(SyncTiming(heartbeatMs = 50, reconnectMinMs = 60_000, reconnectMaxMs = 60_000))
        end.close(1001, "restart")
        await(session) { it.connection == Connection.Reconnecting }
        session.reconnectNow()
        assertEquals("m1", frame("hello").text("memberId"))
    }

    @Test
    fun `a room the server no longer knows ends the session`() {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest) = MockResponse().setResponseCode(404)
        }
        val fake = FakeJuntosApi()
        val gone = object : JuntosApi by fake {
            override suspend fun preview(roomId: String): RoomPreview = throw ApiException(404, "room_not_found")
        }
        assertEquals(SyncEvent.RoomGone, await(session(api = gone)) { it.ended != null }.ended)
    }
}
