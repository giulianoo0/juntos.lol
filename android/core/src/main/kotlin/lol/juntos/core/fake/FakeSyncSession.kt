package lol.juntos.core.fake

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import lol.juntos.core.model.ChatMessage
import lol.juntos.core.model.Member
import lol.juntos.core.model.PlayState
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.sync.Connection
import lol.juntos.core.sync.Door
import lol.juntos.core.sync.ReadyReport
import lol.juntos.core.sync.SessionRequest
import lol.juntos.core.sync.SyncEvent
import lol.juntos.core.sync.SyncSession
import lol.juntos.core.sync.SyncSessionFactory
import lol.juntos.core.sync.SyncState

/** A room without a server, for screens and previews: the test scripts what happens. */
class FakeSyncSession(
    request: SessionRequest,
    room: RoomInfo = RoomInfo(id = request.roomId, name = "Sala de teste", status = "ready", durationMs = 596_000),
    private val now: () -> Long = System::currentTimeMillis,
) : SyncSession {
    private val me = Member(id = "me", nickname = request.nickname)
    private val _state = MutableStateFlow(
        SyncState(
            connection = Connection.Open,
            door = Door.In,
            memberId = me.id,
            controllerId = me.id,
            members = listOf(me),
            playState = PlayState(playing = false, positionMs = 0, serverTimeMs = now()),
            room = room,
        ),
    )
    private val _events = MutableSharedFlow<SyncEvent>(extraBufferCapacity = 8)
    override val state: StateFlow<SyncState> = _state
    override val events: SharedFlow<SyncEvent> = _events

    val sentReady = mutableListOf<ReadyReport>()

    override fun play(positionMs: Long) = setPlay(true, positionMs)
    override fun pause(positionMs: Long) = setPlay(false, positionMs)
    override fun seek(positionMs: Long) = setPlay(_state.value.playState?.playing == true, positionMs)

    override fun chat(text: String) = say(me.nickname, text)
    override fun ready(report: ReadyReport) { sentReady += report }
    override fun leave() = close()
    override fun close() = _state.update { it.copy(connection = Connection.Closed) }

    fun join(member: Member) = _state.update { it.copy(members = it.members + member) }
    fun drop(memberId: String) = _state.update { s -> s.copy(members = s.members.filterNot { it.id == memberId }) }
    fun change(member: Member) = _state.update { s -> s.copy(members = s.members.map { if (it.id == member.id) member else it }) }
    fun say(author: String, text: String) = _state.update { it.copy(chat = it.chat + ChatMessage(author, text)) }
    fun emit(event: SyncEvent) = _events.tryEmit(event)

    private fun setPlay(playing: Boolean, positionMs: Long) = _state.update {
        it.copy(playState = PlayState(playing = playing, positionMs = positionMs, serverTimeMs = now()))
    }
}

class FakeSyncSessionFactory : SyncSessionFactory {
    val opened = mutableListOf<FakeSyncSession>()
    override fun open(request: SessionRequest): SyncSession = FakeSyncSession(request).also { opened += it }
}
