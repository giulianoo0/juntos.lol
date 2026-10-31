package lol.juntos.player

import kotlinx.coroutines.flow.StateFlow
import lol.juntos.core.sync.PlaybackTarget

/** A playlist and where its time zero sits on the room's timeline (a region's start). */
data class MediaSource(
    val masterUrl: String,
    val offsetMs: Long = 0,
    val sidecarSubtitles: List<SidecarSubtitle> = emptyList(),
)

/** A subtitle outside the HLS master: the room's .vtt/.ass and the viewer's own imports. */
data class SidecarSubtitle(val url: String, val language: String, val label: String, val mimeType: String)

data class TrackOption(val index: Int, val label: String, val language: String? = null, val selected: Boolean = false)

data class PlayerSnapshot(
    val durationMs: Long = 0,
    /** Room time, offset applied. */
    val positionMs: Long = 0,
    val bufferedAheadMs: Long = 0,
    val playing: Boolean = false,
    val buffering: Boolean = false,
    val error: String? = null,
    val videoCodec: String? = null,
    /** The decoder Media3 picked, e.g. c2.android.av1.decoder: what the codec matrix checks. */
    val videoDecoder: String? = null,
    val audio: List<TrackOption> = emptyList(),
    val subtitles: List<TrackOption> = emptyList(),
    val qualities: List<TrackOption> = emptyList(),
    val droppedFrames: Long = 0,
    val decodedFrames: Long = 0,
    /** This viewer's shift of the subtitles: positive shows them later. */
    val subtitleDelayMs: Long = 0,
)

/** The room's player. Positions are room time; [load] takes care of the region offset. */
interface JuntosPlayer : PlaybackTarget {
    val snapshot: StateFlow<PlayerSnapshot>
    fun load(source: MediaSource, startAtMs: Long = source.offsetMs)
    fun selectAudio(index: Int)

    /** The room's subtitles changed while the media did not (the host imported one): the media plays on. */
    fun setSidecarSubtitles(subtitles: List<SidecarSubtitle>)

    /** Null turns subtitles off. The pick and the delay outlive a [load] of another region. */
    fun selectSubtitle(index: Int?)

    /** Per viewer, in steps of 250 ms up to ±600 s, as on the site: positive shows the subtitles later, negative sooner. */
    fun setSubtitleDelay(ms: Long)

    /** A file the viewer picked (SRT, VTT, ASS or SSA), for them alone: its index among the subtitles, selected, or null when it holds no cue. */
    fun importSubtitle(name: String, text: String): Int?

    /** Null is automatic. */
    fun selectQuality(index: Int?)
    fun release()
}

fun interface PlayerFactory {
    fun create(): JuntosPlayer
}
