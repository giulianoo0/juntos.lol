package lol.juntos.core.sync

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import lol.juntos.core.model.ChatMessage
import lol.juntos.core.model.HostSubtitles
import lol.juntos.core.model.Member
import lol.juntos.core.model.PlayState
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.RoomWaiting
import lol.juntos.core.model.Spotlight

enum class Connection { Connecting, Open, Reconnecting, Closed }

/** Where the member stands at the room's door, as the socket tells it. */
enum class Door { Joining, In, Lobby, Password, BadPassword, Denied }

data class SyncState(
    val connection: Connection = Connection.Connecting,
    val door: Door = Door.Joining,
    val memberId: String? = null,
    val controllerId: String? = null,
    val members: List<Member> = emptyList(),
    val chat: List<ChatMessage> = emptyList(),
    val playState: PlayState? = null,
    /** Server clock minus this device's, from the heartbeat round trip. */
    val serverOffsetMs: Long = 0,
    /** The room as GET /api/rooms/{id} last told it, refreshed on roomUpdated. */
    val room: RoomInfo? = null,
    val waiting: RoomWaiting? = null,
    val spotlight: Spotlight? = null,
    /** Signs the member's own calls to the room's HTTP routes, with [memberId]. */
    val capability: String? = null,
    /** Whether play waits for everyone to buffer. */
    val gating: Boolean = true,
    val hostSubtitles: HostSubtitles? = null,
    /** Set while the server asks whether anyone is still watching; [SyncSession.stillHere] answers. */
    val stillThereDeadlineMs: Long? = null,
    /** Why the session ended for good: [SyncEvent.Kicked], [SyncEvent.Replaced] or [SyncEvent.RoomGone]. */
    val ended: SyncEvent? = null,
) {
    val isController: Boolean get() = memberId != null && memberId == controllerId
}

/** Things that happen once: the UI reacts and moves on. */
sealed interface SyncEvent {
    data class Error(val code: String) : SyncEvent
    data object Kicked : SyncEvent
    data object Replaced : SyncEvent
    data object RoomGone : SyncEvent
}

/** What the player measured, sent on ready reports. */
data class ReadyReport(
    val positionMs: Long,
    val bufferAheadMs: Long,
    val stalled: Boolean,
    val bandwidthKbps: Long = 0,
    val mediaKbps: Long = 0,
    val droppedFrames: Long = 0,
    val decodedFrames: Long = 0,
)

data class SessionRequest(
    val roomId: String,
    val nickname: String,
    val ticket: String? = null,
    val ownerToken: String? = null,
    val avatar: String? = null,
    /** Stable per install, so a second socket from this phone takes the seat over instead of doubling it. */
    val device: String? = null,
)

/** One member's socket to /ws/rooms/{id}, reconnecting on its own until closed. */
interface SyncSession {
    val state: StateFlow<SyncState>
    val events: SharedFlow<SyncEvent>

    fun play(positionMs: Long)
    fun pause(positionMs: Long)
    fun seek(positionMs: Long)
    fun chat(text: String)
    fun ready(report: ReadyReport)
    fun stillHere() {}

    /** Leaves on purpose: the seat is not kept. */
    fun leave()
    fun close()
}

fun interface SyncSessionFactory {
    fun open(request: SessionRequest): SyncSession
}
