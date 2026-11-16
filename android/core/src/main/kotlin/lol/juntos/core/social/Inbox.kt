package lol.juntos.core.social

import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import lol.juntos.core.JuntosJson
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

@Serializable
data class FriendPresence(
    val online: Boolean = false,
    val discord: String? = null,
    val inRoom: Boolean = false,
    val roomId: String? = null,
    val roomName: String? = null,
    val withMe: Boolean = false,
)

@Serializable
data class Friend(val id: Long, val nickname: String, val avatar: String = "", val presence: FriendPresence = FriendPresence()) {
    val where: Where
        get() = when {
            presence.inRoom -> Where.Room
            presence.online -> Where.Juntos
            presence.discord != null && presence.discord != "offline" -> Where.Discord
            else -> Where.Away
        }
}

enum class Where { Room, Juntos, Discord, Away }

@Serializable
data class ServerDevice(val id: String, val accountId: Long, val publicKey: String, val label: String = "")

@Serializable
data class WireMessage(
    val id: Long,
    val from: Long,
    val to: Long,
    val senderDevice: String,
    val clientId: String,
    val iv: String,
    val body: String,
    val key: DmCrypto.Wrapped? = null,
    val at: String,
)

enum class MessageState { Sent, Sending, Failed }

data class ChatMessage(
    val id: Long,
    val clientId: String,
    val from: Long,
    val to: Long,
    val at: Instant,
    /** null when this device cannot open it. */
    val text: String?,
    val state: MessageState = MessageState.Sent,
)

data class Thread(
    val friendId: Long,
    val messages: List<ChatMessage> = emptyList(),
    val loaded: Boolean = false,
    val loading: Boolean = false,
    val more: Boolean = false,
    val unread: Int = 0,
    val theyRead: Long = 0,
    val typingUntil: Long = 0,
)

data class InboxState(
    val me: Long? = null,
    val live: Boolean = false,
    val threads: Map<Long, Thread> = emptyMap(),
    val friends: List<Friend>? = null,
) {
    val unread: Int get() = threads.values.sumOf { it.unread }
}

/** Where this device keeps its key and id, per account. */
interface DeviceStore {
    fun key(accountId: Long): DeviceKey
    fun deviceId(accountId: Long): String?
    fun saveDeviceId(accountId: Long, id: String)
    fun forget(accountId: Long)
    /** From now on this device is the one [carried] came from. */
    fun adopt(accountId: Long, carried: DmCrypto.CarriedKey)
}

@Serializable private data class DeviceBody(val publicKey: String, val label: String)
@Serializable private data class KeysReply(val mine: List<ServerDevice>, val theirs: List<ServerDevice>)
@Serializable private data class PageReply(val messages: List<WireMessage>, val theyRead: Long = 0, val more: Boolean = false)
@Serializable private data class ThreadsReply(val threads: List<ThreadReply>)
@Serializable private data class ThreadReply(val other: Long, val last: WireMessage? = null, val unread: Int = 0, val theyRead: Long = 0)
@Serializable private data class SinceReply(val messages: List<WireMessage>)
@Serializable private data class FriendsReply(val friends: List<Friend>)
@Serializable private data class SendBody(val senderDevice: String, val clientId: String, val iv: String, val body: String, val keys: Map<String, DmCrypto.Wrapped>)
@Serializable private data class SendConflict(val error: String? = null, val mine: List<ServerDevice>? = null, val theirs: List<ServerDevice>? = null)
@Serializable private data class ReadBody(val upTo: Long)
@Serializable private data class Event(val type: String, val id: Long = 0, val from: Long = 0, val upTo: Long = 0, val message: WireMessage? = null)

private class HttpReply(val status: Int, val body: String)

private suspend fun Call.await(): HttpReply = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
        override fun onResponse(call: Call, response: Response) {
            runCatching { response.use { HttpReply(it.code, it.body?.string().orEmpty()) } }
                .fold({ continuation.resume(it) }, { continuation.resumeWithException(it) })
        }
    })
}

private suspend fun Call.awaitBytes(): ByteArray? = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)
        override fun onResponse(call: Call, response: Response) {
            runCatching { response.use { if (it.isSuccessful) it.body?.bytes() else null } }
                .fold({ continuation.resume(it) }, { continuation.resumeWithException(it) })
        }
    })
}

/**
 * The signed-in account's live side, as web/src/social/inbox.ts keeps it: one socket to
 * /ws/inbox for messages, receipts, typing and nudges; it reconnects by itself and fetches
 * what came while away. Messages are sealed and opened here, with this device's key.
 */
class Inbox(
    baseUrl: String,
    private val client: OkHttpClient,
    private val devices: DeviceStore,
    private val label: String = "Android",
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob()),
) {
    private val base: HttpUrl = baseUrl.toHttpUrl()
    private val json = "application/json".toMediaType()
    private val _state = MutableStateFlow(InboxState())
    val state: StateFlow<InboxState> = _state.asStateFlow()

    private var key: DeviceKey? = null
    private var deviceId: String? = null
    private var socket: WebSocket? = null
    private var run: Job? = null
    private var generation = 0
    private var lastSeen = 0L
    private var openThread: Long? = null
    private val publicKeys = ConcurrentHashMap<String, String>()
    private val wrapKeys = ConcurrentHashMap<String, ByteArray>()
    private val pairs = ConcurrentHashMap<Long, KeysReply>()
    private val mutex = Mutex()

    private fun url(vararg path: String, query: Map<String, String> = emptyMap()): HttpUrl =
        base.newBuilder().apply {
            path.forEach { addPathSegment(it) }
            query.forEach { (k, v) -> addQueryParameter(k, v) }
        }.build()

    private suspend fun get(url: HttpUrl) = client.newCall(Request.Builder().url(url).build()).await()

    private suspend fun post(url: HttpUrl, body: String) =
        client.newCall(Request.Builder().url(url).post(body.toRequestBody(json)).build()).await()

    /** Opens the inbox for [accountId], or closes it for nobody. */
    fun signedIn(accountId: Long?) {
        if (accountId == _state.value.me) return
        stop()
        if (accountId == null) return
        val mine = ++generation
        _state.value = InboxState(me = accountId)
        run = scope.launch { start(accountId, mine) }
    }

    private suspend fun start(accountId: Long, mine: Int) {
        var wait = 1000L
        while (mine == generation) {
            try {
                register(accountId)
                break
            } catch (_: Exception) {
                delay(wait)
                wait = (wait * 2).coerceAtMost(30_000)
            }
        }
        if (mine == generation) connect(accountId, mine, 0)
        refreshFriends()
    }

    private suspend fun register(accountId: Long) {
        val deviceKey = devices.key(accountId)
        val reply = post(url("api", "dm", "devices"), JuntosJson.encodeToString(DeviceBody(deviceKey.publicKey, label)))
        if (reply.status !in 200..299) throw IOException("device ${reply.status}")
        val device = JuntosJson.decodeFromString<ServerDevice>(reply.body)
        devices.saveDeviceId(accountId, device.id)
        key = deviceKey
        deviceId = device.id
        wrapKeys.clear()
    }

    private fun connect(accountId: Long, mine: Int, attempt: Int) {
        val device = deviceId ?: return
        val wsUrl = url("ws", "inbox", query = mapOf("device" to device)).toString().replaceFirst("http", "ws")
        socket = client.newWebSocket(Request.Builder().url(wsUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (mine != generation) {
                    webSocket.cancel()
                    return
                }
                _state.update { it.copy(live = true) }
                scope.launch {
                    catchUp()
                    refreshFriends()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (mine != generation) return
                val event = runCatching { JuntosJson.decodeFromString<Event>(text) }.getOrNull() ?: return
                scope.launch { handle(event) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = closed(response?.code)
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed(null)

            private fun closed(status: Int?) {
                if (mine != generation) return
                _state.update { it.copy(live = false) }
                scope.launch {
                    delay((1000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000))
                    if (mine != generation) return@launch
                    if (status == 409 || attempt >= 3) runCatching { register(accountId) }
                    connect(accountId, mine, attempt + 1)
                }
            }
        })
    }

    /** Asks again for the friends and where they are. */
    suspend fun refreshFriends() {
        val reply = runCatching { get(url("api", "friends")) }.getOrNull() ?: return
        if (reply.status !in 200..299) return
        val friends = runCatching { JuntosJson.decodeFromString<FriendsReply>(reply.body).friends }.getOrNull() ?: return
        _state.update { it.copy(friends = friends.sortedWith(compareBy<Friend> { f -> f.where.ordinal }.thenBy { f -> f.nickname.lowercase() })) }
    }

    private suspend fun handle(event: Event) {
        when (event.type) {
            "dm" -> event.message?.let { receive(it) }
            "read" -> patch(event.from) { it.copy(theyRead = maxOf(it.theyRead, event.upTo)) }
            "readMine" -> patch(event.from) { it.copy(unread = 0) }
            "typing" -> patch(event.from) { it.copy(typingUntil = System.currentTimeMillis() + 5000) }
            "presence", "friends" -> refreshFriends()
        }
    }

    private fun thread(friendId: Long) = _state.value.threads[friendId] ?: Thread(friendId)

    private fun patch(friendId: Long, change: (Thread) -> Thread) {
        if (friendId == 0L) return
        _state.update { it.copy(threads = it.threads + (friendId to change(it.threads[friendId] ?: Thread(friendId)))) }
    }

    private fun otherOf(from: Long, to: Long) = if (from == _state.value.me) to else from

    private suspend fun keysWith(friendId: Long, fresh: Boolean = false): KeysReply {
        if (!fresh) pairs[friendId]?.let { return it }
        val reply = get(url("api", "dm", "with", friendId.toString(), "keys"))
        if (reply.status !in 200..299) throw IOException("keys ${reply.status}")
        val keys = JuntosJson.decodeFromString<KeysReply>(reply.body)
        remember(keys)
        pairs[friendId] = keys
        return keys
    }

    private fun remember(keys: KeysReply) {
        (keys.mine + keys.theirs).forEach { publicKeys[it.id] = it.publicKey }
    }

    private fun wrapKeyFor(device: String, publicKey: String): ByteArray = wrapKeys.getOrPut(device) {
        val secret = key!!.agree(DmCrypto.publicFromRaw(DmCrypto.unb64(publicKey)))
        DmCrypto.wrapKey(secret, deviceId!!, device)
    }

    private suspend fun decrypt(wire: WireMessage): ChatMessage {
        val at = runCatching { Instant.parse(wire.at) }.getOrElse { Instant.now() }
        val base = ChatMessage(wire.id, wire.clientId, wire.from, wire.to, at, null)
        val wrapped = wire.key ?: return base
        var sender = publicKeys[wire.senderDevice]
        if (sender == null) {
            runCatching { keysWith(otherOf(wire.from, wire.to), fresh = true) }
            sender = publicKeys[wire.senderDevice]
        }
        sender ?: return base
        return runCatching { base.copy(text = DmCrypto.open(wire.from, wire.to, wire.clientId, wire.iv, wire.body, wrapped, wrapKeyFor(wire.senderDevice, sender))) }
            .getOrElse { base }
    }

    private fun place(message: ChatMessage, opened: Boolean) {
        lastSeen = maxOf(lastSeen, message.id)
        val friendId = otherOf(message.from, message.to)
        patch(friendId) { t ->
            val known = t.messages.any { it.id == message.id && it.id != 0L }
            val messages = (t.messages.filter { it.clientId != message.clientId && (it.id == 0L || it.id != message.id) } + message).sortedWith(order)
            val fromThem = message.from == friendId
            t.copy(messages = messages, unread = if (fromThem && !known && !opened) t.unread + 1 else t.unread, typingUntil = if (fromThem) 0 else t.typingUntil)
        }
    }

    private val order = Comparator<ChatMessage> { a, b ->
        when {
            a.id != 0L && b.id != 0L -> a.id.compareTo(b.id)
            a.id == 0L && b.id == 0L -> a.at.compareTo(b.at)
            a.id != 0L -> -1
            else -> 1
        }
    }

    private suspend fun receive(wire: WireMessage) {
        val message = decrypt(wire)
        val friendId = otherOf(message.from, message.to)
        val showing = openThread == friendId
        place(message, showing)
        if (showing && message.from == friendId) markRead(friendId)
    }

    private suspend fun catchUp() = mutex.withLock {
        val device = deviceId ?: return
        if (lastSeen == 0L) {
            val reply = runCatching { get(url("api", "dm", "threads", query = mapOf("device" to device))) }.getOrNull() ?: return
            if (reply.status !in 200..299) return
            for (each in JuntosJson.decodeFromString<ThreadsReply>(reply.body).threads) {
                val last = each.last?.let { decrypt(it) }
                if (last != null) lastSeen = maxOf(lastSeen, last.id)
                patch(each.other) { t ->
                    val messages = if (last != null && t.messages.none { it.id == last.id }) (t.messages + last).sortedWith(order) else t.messages
                    t.copy(messages = messages, unread = each.unread, theyRead = each.theyRead)
                }
            }
            return
        }
        val reply = runCatching { get(url("api", "dm", "since", query = mapOf("device" to device, "after" to lastSeen.toString()))) }.getOrNull() ?: return
        if (reply.status !in 200..299) return
        JuntosJson.decodeFromString<SinceReply>(reply.body).messages.forEach { receive(it) }
    }

    /** The first page of a conversation, or the one before what is loaded. */
    fun load(friendId: Long, older: Boolean = false) {
        val current = thread(friendId)
        val device = deviceId ?: return
        if (current.loading || (older && !current.more)) return
        patch(friendId) { it.copy(loading = true) }
        scope.launch {
            try {
                val first = current.messages.firstOrNull { it.id > 0 }
                val query = buildMap { put("device", device); if (older && first != null) put("before", first.id.toString()) }
                val reply = get(url("api", "dm", "with", friendId.toString(), query = query))
                if (reply.status !in 200..299) throw IOException("thread ${reply.status}")
                val page = JuntosJson.decodeFromString<PageReply>(reply.body)
                runCatching { keysWith(friendId) }
                val opened = page.messages.map { decrypt(it) }
                opened.forEach { lastSeen = maxOf(lastSeen, it.id) }
                patch(friendId) { t ->
                    val ids = opened.map { it.id }.toSet()
                    t.copy(
                        messages = (t.messages.filter { it.id == 0L || it.id !in ids } + opened).sortedWith(order),
                        loaded = true, loading = false, more = if (older || !t.loaded) page.more else t.more, theyRead = page.theyRead,
                    )
                }
            } catch (_: Exception) {
                patch(friendId) { it.copy(loading = false) }
            }
        }
    }

    /** Says which conversation is on screen; null for none. */
    fun show(friendId: Long?) {
        openThread = friendId
        if (friendId != null) scope.launch { markRead(friendId) }
    }

    private suspend fun markRead(friendId: Long) {
        val t = thread(friendId)
        val newest = t.messages.lastOrNull { it.from == friendId && it.id > 0 }
        if (t.unread > 0) patch(friendId) { it.copy(unread = 0) }
        newest ?: return
        runCatching { post(url("api", "dm", "with", friendId.toString(), "read"), JuntosJson.encodeToString(ReadBody(newest.id))) }
    }

    /** Seals and sends; the message shows at once and settles as the server answers. */
    fun send(friendId: Long, text: String, clientId: String = DmCrypto.b64(DmCrypto.randomBytes(12))) {
        val me = _state.value.me ?: return
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        patch(friendId) { t ->
            t.copy(messages = (t.messages.filter { it.clientId != clientId } + ChatMessage(0, clientId, me, friendId, Instant.now(), trimmed, MessageState.Sending)).sortedWith(order))
        }
        scope.launch {
            try {
                val device = deviceId ?: throw IOException("no device")
                repeat(2) { attempt ->
                    val keys = keysWith(friendId, fresh = attempt > 0)
                    val recipients = (keys.mine + keys.theirs).associate { it.id to wrapKeyFor(it.id, it.publicKey) }
                    val sealed = DmCrypto.seal(trimmed, me, friendId, clientId, recipients)
                    val reply = post(url("api", "dm", "with", friendId.toString()), JuntosJson.encodeToString(SendBody(device, clientId, sealed.iv, sealed.body, sealed.keys)))
                    if (reply.status == 409) {
                        val conflict = runCatching { JuntosJson.decodeFromString<SendConflict>(reply.body) }.getOrNull()
                        if (conflict?.mine != null && conflict.theirs != null) {
                            val fresh = KeysReply(conflict.mine, conflict.theirs)
                            remember(fresh)
                            pairs[friendId] = fresh
                        }
                        return@repeat
                    }
                    if (reply.status !in 200..299) throw IOException("send ${reply.status}")
                    val sent = JuntosJson.decodeFromString<WireMessage>(reply.body)
                    place(ChatMessage(sent.id, clientId, me, friendId, runCatching { Instant.parse(sent.at) }.getOrElse { Instant.now() }, trimmed), true)
                    return@launch
                }
                throw IOException("devices kept changing")
            } catch (_: Exception) {
                patch(friendId) { t -> t.copy(messages = t.messages.map { if (it.clientId == clientId && it.id == 0L) it.copy(state = MessageState.Failed) else it }) }
            }
        }
    }

    fun retry(friendId: Long, clientId: String) {
        val failed = thread(friendId).messages.firstOrNull { it.clientId == clientId } ?: return
        failed.text?.let { send(friendId, it, clientId) }
    }

    private var lastTyping = 0L

    fun typing(friendId: Long) {
        val now = System.currentTimeMillis()
        if (now - lastTyping < 3000) return
        lastTyping = now
        socket?.send("""{"type":"typing","to":$friendId}""")
    }

    private val avatars = ConcurrentHashMap<Long, ByteArray>()

    /** A friend's Discord picture, through the site so their Discord id stays private; null when there is none. */
    suspend fun discordAvatar(id: Long): ByteArray? {
        avatars[id]?.let { return it }
        val reply = runCatching {
            client.newCall(Request.Builder().url(url("api", "users", id.toString(), "discord-avatar")).build()).awaitBytes()
        }.getOrNull() ?: return null
        avatars[id] = reply
        return reply
    }

    /** The app left the screen: the socket closes, so friends stop seeing it as open. */
    fun pause() {
        if (_state.value.me == null) return
        generation++
        run?.cancel()
        socket?.close(1000, null)
        socket = null
        _state.update { it.copy(live = false) }
    }

    /** Back on screen: the socket opens again and catches up. */
    fun resume() {
        val me = _state.value.me ?: return
        if (socket != null) return
        val mine = ++generation
        run = scope.launch {
            if (deviceId == null) start(me, mine) else {
                connect(me, mine, 0)
            }
        }
    }

    /** The app came back to the front: read again who is around and what came. */
    fun wake() {
        if (_state.value.me == null) return
        scope.launch {
            refreshFriends()
            if (_state.value.live) catchUp()
        }
    }

    /** This device's key as text to carry to another device, or null. */
    fun exportKey(): String? {
        val me = _state.value.me ?: return null
        return DmCrypto.exportKey(me, deviceId ?: return null, key ?: return null)
    }

    /** Takes the key of another device of this account: from here on this one is that device. */
    suspend fun importKey(text: String) {
        val me = _state.value.me ?: throw DmCrypto.KeyImportException(false)
        val carried = DmCrypto.importKey(text, me)
        val previous = deviceId
        if (previous != null && previous != carried.deviceId) {
            runCatching {
                client.newCall(Request.Builder().url(url("api", "dm", "devices", previous)).delete().build()).await()
            }
        }
        devices.adopt(me, carried)
        stop()
        signedIn(me)
    }

    fun stop() {
        generation++
        run?.cancel()
        socket?.cancel()
        socket = null
        key = null
        deviceId = null
        lastSeen = 0
        publicKeys.clear()
        wrapKeys.clear()
        pairs.clear()
        _state.value = InboxState()
    }
}
