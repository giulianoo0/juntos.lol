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
    subtitleUrl(room, track)?.let { SidecarSubtitle(it, track.language, subtitleLabel(track.title, track.language), "text/vtt") }
}

/** YouTube names a track by its language in English ("Portuguese"): that reads in Portuguese here; any other title stays. */
internal fun subtitleLabel(title: String, language: String): String {
    val english = java.util.Locale.forLanguageTag(language).getDisplayLanguage(java.util.Locale.ENGLISH)
    val plain = title.isBlank() || title.equals(english, ignoreCase = true)
    return if (plain) languageLabel(language) ?: title.ifBlank { language } else title
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
internal fun FollowRoom(baseUrl: String, session: SyncSession, player: JuntosPlayer, host: LocalHost? = null) {
    var loaded by remember(session, player) { mutableStateOf<MediaPick?>(null) }
    var sidecars by remember(session, player) { mutableStateOf<List<SidecarSubtitle>>(emptyList()) }
    LaunchedEffect(session, player) {
        while (true) {
            val now = session.state.value
            val own = host?.media?.value
            val ownRoom = now.room?.takeIf { own != null && it.sourceMemberId == now.memberId && it.mediaGeneration == own.generation }
            val room = now.room?.takeIf { it.status == "ready" }
            if (ownRoom != null && host != null) {
                // The host plays its own cache, not the bucket.
                val position = roomPositionMs(now)
                host.follow(position)
                host.low(ownRoom.renditions.orEmpty().contains("480p"))
                val subtitles = roomSubtitles(ownRoom)
                val local = host.master(position, loaded?.regionN)
                if (local != null) {
                    val (file, region) = local
                    val pick = MediaPick("file://${file.path}", region.startMs, region.n)
                    if (pick != loaded) {
                        player.load(MediaSource(pick.masterUrl, pick.offsetMs, subtitles), startAtMs = position)
                        loaded = pick
                    } else if (subtitles != sidecars) {
                        player.setSidecarSubtitles(subtitles)
                    }
                    sidecars = subtitles
                }
            } else if (room != null) {
                val position = roomPositionMs(now)
                val subtitles = roomSubtitles(room)
                val pick = needsReload(loaded, baseUrl, room, position)
                if (pick != null) {
                    player.load(MediaSource(pick.masterUrl, pick.offsetMs, subtitles), startAtMs = position)
                    loaded = pick
                } else if (subtitles != sidecars) {
                    player.setSidecarSubtitles(subtitles)
                }
                sidecars = subtitles
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
            if (BuildConfig.DEBUG && snapshot.playing) Log.d("JuntosSync", "at=${snapshot.positionMs} drift=${snapshot.positionMs - roomPositionMs(session.state.value)} buffer=${snapshot.bufferedAheadMs}")
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
