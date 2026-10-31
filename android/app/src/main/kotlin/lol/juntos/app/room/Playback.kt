package lol.juntos.app.room

import android.util.Log
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import lol.juntos.app.BuildConfig
import lol.juntos.core.media.MediaPick
import lol.juntos.core.media.mediaPick
import lol.juntos.core.media.subtitleUrl
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.sync.ReadyReport
import lol.juntos.core.sync.SyncDriver
import lol.juntos.core.sync.SyncSession
import lol.juntos.core.sync.SyncState
import lol.juntos.core.sync.expectedPositionMs
import lol.juntos.core.sync.follow
import lol.juntos.core.sync.reportReadiness
import lol.juntos.player.JuntosPlayer
import lol.juntos.player.MediaSource
import lol.juntos.player.SidecarSubtitle
import lol.juntos.player.languageLabel

/** The room's subtitles as the player fetches them: always the bucket's WebVTT. */
internal fun roomSubtitles(room: RoomInfo): List<SidecarSubtitle> = room.subtitleTracks.orEmpty().mapNotNull { track ->
    subtitleUrl(room, track)?.let { SidecarSubtitle(it, track.language, track.title.ifBlank { languageLabel(track.language) ?: track.language }, "text/vtt") }
}

/** Where the room is now, on its own clock. */
internal fun roomPositionMs(state: SyncState, nowMs: Long = System.currentTimeMillis()): Long =
    state.playState?.let { expectedPositionMs(it, nowMs + state.serverOffsetMs) } ?: 0L

/** Whether a loaded pick no longer answers for [room] at [positionMs]: other media, another region, or a reload the server asked for. */
internal fun needsReload(loaded: MediaPick?, baseUrl: String, room: RoomInfo, positionMs: Long): MediaPick? {
    val pick = mediaPick(baseUrl, room, positionMs, loaded?.regionN)
    return pick.takeIf { it != loaded }
}

/**
 * Keeps [player] on the room while composed: loads the region holding the room's position when
 * the media or its regions move, follows the play state, and answers the gate with what is buffered.
 */
@Composable
internal fun FollowRoom(baseUrl: String, session: SyncSession, player: JuntosPlayer) {
    var loaded by remember(session) { mutableStateOf<MediaPick?>(null) }
    LaunchedEffect(session, player) {
        while (true) {
            val now = session.state.value
            val room = now.room?.takeIf { it.status == "ready" }
            if (room != null) {
                val position = roomPositionMs(now)
                needsReload(loaded, baseUrl, room, position)?.let { pick ->
                    player.load(MediaSource(pick.masterUrl, pick.offsetMs, roomSubtitles(room)), startAtMs = position)
                    loaded = pick
                }
            }
            // The next word from the socket, or a second on, since playing moves the position out of a region by itself.
            withTimeoutOrNull(1_000) { session.state.drop(1).first() }
        }
    }
    LaunchedEffect(session, player) { SyncDriver(player).follow(session) }
    LaunchedEffect(session, player) {
        session.reportReadiness({
            if (loaded == null) return@reportReadiness null
            val snapshot = player.snapshot.value
            if (BuildConfig.DEBUG && snapshot.playing) Log.d("JuntosSync", "drift=${snapshot.positionMs - roomPositionMs(session.state.value)} buffer=${snapshot.bufferedAheadMs}")
            ReadyReport(
                positionMs = snapshot.positionMs,
                bufferAheadMs = snapshot.bufferedAheadMs,
                stalled = snapshot.buffering,
                droppedFrames = snapshot.droppedFrames,
                decodedFrames = snapshot.decodedFrames,
            )
        })
    }
}
