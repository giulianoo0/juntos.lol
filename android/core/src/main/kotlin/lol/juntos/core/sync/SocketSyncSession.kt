package lol.juntos.core.sync

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import lol.juntos.core.JuntosJson
import lol.juntos.core.api.ApiException
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.human.HumanGate
import lol.juntos.core.model.ChatMessage
import lol.juntos.core.model.HostSubtitles
import lol.juntos.core.model.MediaSnapshot
import lol.juntos.core.model.Member
import lol.juntos.core.model.MemberReadiness
import lol.juntos.core.model.PlayState
import lol.juntos.core.model.RoomWaiting
import lol.juntos.core.model.Seat
import lol.juntos.core.model.Spotlight
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import kotlin.math.min
import kotlin.math.roundToLong
import kotlin.random.Random

/**
 * The server answers every heartbeat, so one left unanswered [deadAfterMs] means a dead socket
 * whatever OkHttp believes: a phone learns of a lost link only when a write fails.
 */
data class SyncTiming(
    val heartbeatMs: Long = 5_000,
    val deadAfterMs: Long = 15_000,
    val reconnectMinMs: Long = 500,
    val reconnectMaxMs: Long = 8_000,
)

/** web/src/player/useSync.ts on OkHttp: one member's socket to /ws/rooms/{id}. */
@OptIn(ExperimentalCoroutinesApi::class)
class SocketSyncSession(
    private val request: SessionRequest,
    baseUrl: String,
    private val client: OkHttpClient,
    private val api: JuntosApi,
    private val human: HumanGate? = null,
    private val timing: SyncTiming = SyncTiming(),
    private val now: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
) : SyncSession {
    // Everything below runs on this one thread, OkHttp's callbacks included.
    private val scope = CoroutineScope(SupervisorJob() + dispatcher.limitedParallelism(1))
    private val socketUrl = baseUrl.toHttpUrl().newBuilder()
        .addPathSegment("ws").addPathSegment("rooms").addPathSegment(request.roomId)
        .build()
    private val _state = MutableStateFlow(SyncState())
    private val _events = MutableSharedFlow<SyncEvent>(extraBufferCapacity = 16)
    override val state: StateFlow<SyncState> = _state.asStateFlow()
    override val events: SharedFlow<SyncEvent> = _events.asSharedFlow()

    private var socket: WebSocket? = null
    private var opened = false
    private var welcomed = false
    private var seat: Seat? = null
    private var attempt = 0
    // The door said no, or we are gone: nothing reconnects.
    private var halted = false
    private var unansweredSince: Long? = null
    private var retry: Job? = null
    private val pendingChat = ArrayDeque<String>()
    private var announced: String? = null
    private val refreshes = Channel<Unit>(Channel.CONFLATED)

    init {
        scope.launch { for (ignored in refreshes) refreshRoom() }
        scope.launch {
            while (isActive) {
                delay(timing.heartbeatMs)
                heartbeat()
            }
        }
        scope.launch { connect() }
        refreshes.trySend(Unit)
    }

    override fun play(positionMs: Long) = command("play", positionMs)

    override fun pause(positionMs: Long) = command("pause", positionMs)

    override fun seek(positionMs: Long) = later { sendLive("seek") { put("positionMs", positionMs) } }

    override fun chat(text: String) = later {
        val live = socket
        if (live != null && welcomed) live.send(chatFrame(text)) else pendingChat.addLast(text)
    }

    override fun ready(report: ReadyReport) = later {
        sendLive("ready") {
            put("positionMs", report.positionMs)
            put("bufferAheadMs", report.bufferAheadMs)
            if (report.stalled) put("stalled", true)
            if (report.bandwidthKbps > 0) put("bandwidthKbps", report.bandwidthKbps)
            if (report.mediaKbps > 0) put("mediaKbps", report.mediaKbps)
            if (report.decodedFrames > 0) {
                put("droppedFrames", report.droppedFrames)
                put("decodedFrames", report.decodedFrames)
            }
        }
    }

    override fun stillHere() = later { sendLive("stillHere") {} }

    override fun announceSource(origin: String?) = later {
        announced = origin
        origin?.let { sendLive("source") { put("origin", it) } }
    }

    override fun admit(requestId: String) = answer("admit", requestId)

    override fun deny(requestId: String) = answer("deny", requestId)

    override fun reconnectNow() = later {
        if (halted || socket != null) return@later
        retry?.cancel()
        attempt = 0
        retry = scope.launch { connect() }
    }

    private fun answer(type: String, requestId: String) = later {
        if (socket == null || !opened) return@later
        sendLive(type) { put("targetId", requestId) }
        _state.update { s -> s.copy(knocks = s.knocks.filterNot { it.requestId == requestId }) }
    }

    override fun leave() = later {
        socket?.takeIf { opened }?.send(frame("leave") {})
        shutDown()
    }

    override fun close() = later { shutDown() }

    private fun command(type: String, positionMs: Long) = later {
        sendLive(type) {
            put("positionMs", positionMs)
            put("rate", _state.value.playState?.rate ?: 1.0)
        }
    }

    private fun later(block: () -> Unit) {
        scope.launch { block() }
    }

    private fun shutDown() {
        halted = true
        retry?.cancel()
        socket?.close(1000, null)
        socket = null
        _state.update { it.copy(connection = Connection.Closed) }
        scope.cancel()
    }

    private suspend fun connect() {
        if (halted) return
        // The socket only opens for a phone that passed the bot check lately.
        human?.let { gate -> runCatching { gate.ensure() }.onFailure { if (it is CancellationException) throw it } }
        if (halted) return
        opened = false
        welcomed = false
        unansweredSince = null
        socket = client.newWebSocket(Request.Builder().url(socketUrl).build(), Listener())
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) = on(webSocket) { opened() }

        override fun onMessage(webSocket: WebSocket, text: String) = on(webSocket) { received(text) }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = on(webSocket) { dropped(null) }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            on(webSocket) { dropped(response?.code) }

        // A socket this session already moved on from: its last words are not ours.
        private fun on(webSocket: WebSocket, block: () -> Unit) = later { if (webSocket === socket) block() }
    }

    private fun opened() {
        opened = true
        attempt = 0
        _state.update { it.copy(connection = Connection.Open) }
        socket?.send(frame("hello") {
            put("nickname", request.nickname)
            put("clientTimeMs", now())
            request.ownerToken?.let { put("ownerToken", it) }
            request.ticket?.let { put("ticket", it) }
            seat?.let {
                put("memberId", it.memberId)
                put("capability", it.capability)
            }
            request.device?.let { put("device", it) }
            request.avatar?.let { put("avatar", it) }
            put("client", "android")
            // This phone can produce a source itself, so it never counts as waiting on the bucket for its own.
            putJsonArray("features") { add("localSource") }
        })
    }

    private fun received(text: String) {
        unansweredSince = null
        val message = runCatching { JuntosJson.decodeFromString<Outbound>(text) }.getOrNull() ?: return
        if (message.serverTimeMs != null && message.clientTimeMs != null) {
            val offset = message.serverTimeMs - (message.clientTimeMs + (now() - message.clientTimeMs) / 2.0)
            _state.update { it.copy(serverOffsetMs = offset.roundToLong()) }
        }
        when (message.type) {
            "welcome" -> welcome(message)
            "state" -> _state.update { it.copy(waiting = null, playState = message.state ?: it.playState) }
            "waiting" -> _state.update { it.copy(waiting = RoomWaiting(message.targetMs ?: 0, message.readiness.orEmpty())) }
            "members" -> _state.update { it.copy(controllerId = message.controllerId.orEmpty(), members = message.members.orEmpty()) }
            "chat" -> message.message?.let { chat -> _state.update { it.copy(chat = it.chat + chat) } }
            "lobby" -> _state.update { it.copy(door = Door.Lobby) }
            "admitted" -> _state.update { it.copy(door = Door.In) }
            "denied" -> {
                halted = true
                _state.update { it.copy(door = Door.Denied) }
            }
            "error" -> failed(message.error ?: "error")
            "knock" -> message.requestId?.let { id ->
                _state.update { s -> if (s.knocks.any { it.requestId == id }) s else s.copy(knocks = s.knocks + Knock(id, message.nickname.orEmpty())) }
            }
            "stillThere" -> _state.update { it.copy(stillThereDeadlineMs = message.deadlineMs) }
            "awake" -> _state.update { it.copy(stillThereDeadlineMs = null) }
            "gating" -> _state.update { it.copy(gating = message.gating ?: true) }
            "hostSubtitles" -> _state.update { it.copy(hostSubtitles = message.hostSubtitles) }
            "spotlight" -> _state.update { it.copy(spotlight = message.spotlight) }
            "needBrowserMedia" -> _events.tryEmit(SyncEvent.NeedMedia(message.generation ?: 0))
            "browserMediaIdle" -> _events.tryEmit(SyncEvent.MediaIdle)
            "roomStatus" -> refreshes.trySend(Unit)
            "roomUpdated" -> if (message.media != null) patchMedia(message.media) else refreshes.trySend(Unit)
        }
    }

    private fun welcome(message: Outbound) {
        welcomed = true
        seat = Seat(message.memberId.orEmpty(), message.capability.orEmpty())
        _state.update {
            it.copy(
                door = Door.In,
                memberId = message.memberId.orEmpty(),
                controllerId = message.controllerId.orEmpty(),
                members = message.members.orEmpty(),
                chat = message.history.orEmpty(),
                capability = message.capability,
                gating = message.gating ?: true,
                hostSubtitles = message.hostSubtitles,
                waiting = null,
                playState = message.state ?: it.playState,
            )
        }
        while (pendingChat.isNotEmpty()) socket?.send(chatFrame(pendingChat.removeFirst()))
        announced?.let { origin -> socket?.send(frame("source") { put("origin", origin) }) }
        refreshes.trySend(Unit)
    }

    private fun failed(code: String) {
        _events.tryEmit(SyncEvent.Error(code))
        when (code) {
            "password_required" -> stop(Door.Password)
            "bad_ticket" -> stop(Door.BadPassword)
            "room_gone" -> end(SyncEvent.RoomGone)
            "kicked" -> end(SyncEvent.Kicked)
            "replaced" -> end(SyncEvent.Replaced)
        }
    }

    // A password room waits for a ticket: the app opens a new session with one.
    private fun stop(door: Door) {
        halted = true
        _state.update { it.copy(door = door) }
    }

    private fun end(event: SyncEvent) {
        _events.tryEmit(event)
        _state.update { it.copy(ended = event) }
        shutDown()
    }

    private fun dropped(status: Int?) {
        val wasOpen = opened
        socket = null
        opened = false
        welcomed = false
        if (halted) {
            _state.update { it.copy(connection = Connection.Closed) }
            return
        }
        _state.update { it.copy(connection = Connection.Reconnecting) }
        // Refused at the upgrade: the day's check ran out, or the room is no more.
        if (!wasOpen && status == 403) human?.forget()
        val backoff = min(timing.reconnectMinMs shl min(attempt, 16), timing.reconnectMaxMs)
        attempt += 1
        retry = scope.launch {
            delay((backoff * (0.75 + random.nextDouble() * 0.5)).toLong())
            connect()
        }
        if (!wasOpen) scope.launch { if (roomGone()) end(SyncEvent.RoomGone) }
    }

    private fun heartbeat() {
        val live = socket?.takeIf { opened } ?: return
        val since = unansweredSince
        if (since != null && now() - since > timing.deadAfterMs) {
            // The seat is asked back straight away rather than after a backoff.
            attempt = 0
            live.cancel()
            return
        }
        if (since == null) unansweredSince = now()
        live.send(frame("heartbeat") { put("clientTimeMs", now()) })
    }

    /** Whether the server says, beyond doubt, that the room is gone; a failed ask is not that. */
    private suspend fun roomGone(): Boolean = try {
        api.preview(request.roomId)
        false
    } catch (e: ApiException) {
        e.status == 404 && e.code == "room_not_found"
    } catch (e: IOException) {
        false
    }

    private suspend fun refreshRoom() {
        val room = try {
            seat?.let { api.room(request.roomId, it) } ?: api.room(request.roomId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return
        }
        _state.update { it.copy(room = room) }
    }

    /** A publish moved the media: patched in place, unless it is a new source or an older version. */
    private fun patchMedia(media: MediaSnapshot) {
        val room = _state.value.room
        if (room == null || media.mediaGeneration != room.mediaGeneration || media.mediaVersion < (room.mediaVersion ?: 0)) {
            refreshes.trySend(Unit)
            return
        }
        _state.update {
            it.copy(
                room = room.copy(
                    mediaVersion = media.mediaVersion,
                    mediaOffsetMs = media.mediaOffsetMs,
                    mediaRegions = media.mediaRegions,
                ),
            )
        }
    }

    private fun sendLive(type: String, fields: JsonObjectBuilder.() -> Unit) {
        socket?.takeIf { opened }?.send(frame(type, fields))
    }

    private fun chatFrame(text: String) = frame("chat") { put("text", text) }

    private fun frame(type: String, fields: JsonObjectBuilder.() -> Unit): String = buildJsonObject {
        put("type", type)
        fields()
    }.let(JsonObject::toString)

    @Serializable
    private data class Outbound(
        val type: String,
        val memberId: String? = null,
        val state: PlayState? = null,
        val controllerId: String? = null,
        val members: List<Member>? = null,
        val message: ChatMessage? = null,
        val history: List<ChatMessage>? = null,
        val serverTimeMs: Long? = null,
        val clientTimeMs: Long? = null,
        val error: String? = null,
        val capability: String? = null,
        val readiness: List<MemberReadiness>? = null,
        val targetMs: Long? = null,
        val deadlineMs: Long? = null,
        val gating: Boolean? = null,
        val hostSubtitles: HostSubtitles? = null,
        val media: MediaSnapshot? = null,
        val spotlight: Spotlight? = null,
        val requestId: String? = null,
        val nickname: String? = null,
        val generation: Int? = null,
    )
}

class SocketSyncSessionFactory(
    private val baseUrl: String,
    private val client: OkHttpClient,
    private val api: JuntosApi,
    private val human: HumanGate? = null,
) : SyncSessionFactory {
    override fun open(request: SessionRequest): SyncSession = SocketSyncSession(request, baseUrl, client, api, human)
}
