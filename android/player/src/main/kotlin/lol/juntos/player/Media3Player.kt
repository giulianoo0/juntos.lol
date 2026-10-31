package lol.juntos.player

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.SurfaceView
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DecoderCounters
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import kotlin.math.roundToLong

/** Hardware first, then the platform's software decoder (c2.android.*): what the phone's browser won't do for HEVC. */
@OptIn(UnstableApi::class)
private fun preferHardware(skip: Set<String>) = MediaCodecSelector { mimeType, secure, tunneling ->
    MediaCodecUtil.getDecoderInfos(mimeType, secure, tunneling).filterNot { it.name in skip }.sortedBy { !it.hardwareAccelerated }
}

// Buffering with this much in hand and no frame out for this long is the decoder, not the network.
private const val STALL_BUFFER_MS = 5_000L
private const val STALL_MS = 2_500L

private const val TICK_MS = 100L
private const val IMPORTED_FROM = 1000
private const val DELAY_STEP_MS = 250L
private const val DELAY_MAX_MS = 600_000L

private data class TrackRef(val group: Tracks.Group, val track: Int)

/** A subtitle we draw ourselves: the room's sidecars (fetched) and the viewer's imports. */
private class SubtitleTrack(val index: Int, val label: String, val language: String?, val url: String?, var cues: List<SubtitleCue>?)

/** "por", "pt" and "pt-BR" pick the same dub or subtitle after a reload. */
private fun sameLanguage(a: String?, b: String?) =
    a != null && b != null && (languageLabel(a) ?: a.lowercase()) == (languageLabel(b) ?: b.lowercase())

/**
 * The room's player on Media3: HLS over the app's OkHttp client (its cookie jar included).
 * Subtitles bypass Media3's text renderer so a viewer's delay can move them either way.
 * Every call belongs on the main thread.
 */
@OptIn(UnstableApi::class)
class Media3Player(context: Context, private val client: OkHttpClient = OkHttpClient()) : JuntosPlayer {
    private val _snapshot = MutableStateFlow(PlayerSnapshot())
    override val snapshot: StateFlow<PlayerSnapshot> = _snapshot

    private val _cues = MutableStateFlow<List<SubtitleCue>>(emptyList())

    /** The subtitle lines showing now, delay applied, for the surface to draw. */
    val cues: StateFlow<List<SubtitleCue>> = _cues

    private val _videoSize = MutableStateFlow(VideoSize.UNKNOWN)
    val videoSize: StateFlow<VideoSize> = _videoSize

    /** Whether the controls are up: the subtitles climb above them. */
    internal val controlsShown = MutableStateFlow(false)

    /** The rendition playing now: what a pinned quality is checked against. */
    val videoFormat: Format? get() = exo.videoFormat

    /** Decoders that took the stream and gave no frame back, like the emulator's H.264 one on a segment opening with an I-frame that is not an IDR. */
    private val stalled = HashSet<String>()

    internal val exo: ExoPlayer = ExoPlayer.Builder(
        context,
        DefaultRenderersFactory(context).setEnableDecoderFallback(true).setMediaCodecSelector(preferHardware(stalled)),
    )
        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(client)))
        .setLooper(Looper.getMainLooper())
        .build()

    private var offsetMs = 0L
    private var released = false
    private var decoder: String? = null
    private var error: String? = null
    private var audioRefs = emptyList<TrackRef>()
    private var qualityRefs = emptyList<TrackRef>()
    private var audioPick: Pair<String?, String?>? = null

    private var sidecars = emptyList<SubtitleTrack>()
    private val imported = mutableListOf<SubtitleTrack>()
    private val fetched = HashMap<String, List<SubtitleCue>>()
    private var subtitleIndex: Int? = null
    private var subtitlePick: Pair<String?, String>? = null
    private var delayMs = 0L

    private var markCounters: DecoderCounters? = null
    private var markInputs = 0
    private var markFrames = 0
    private var stallSince = 0L

    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            publish()
            handler.postDelayed(this, TICK_MS)
        }
    }

    init {
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .build()
        exo.addListener(object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) = indexTracks(tracks)
            override fun onTrackSelectionParametersChanged(parameters: TrackSelectionParameters) = publish()
            override fun onEvents(player: Player, events: Player.Events) = publish()
            override fun onVideoSizeChanged(videoSize: VideoSize) {
                _videoSize.value = videoSize
            }
            override fun onPlayerError(e: PlaybackException) {
                error = "${e.errorCodeName}: ${e.message}"
                publish()
            }
        })
        exo.addAnalyticsListener(object : AnalyticsListener {
            override fun onVideoDecoderInitialized(
                eventTime: AnalyticsListener.EventTime,
                decoderName: String,
                initializedTimestampMs: Long,
                initializationDurationMs: Long,
            ) {
                decoder = decoderName
            }
            override fun onVideoInputFormatChanged(
                eventTime: AnalyticsListener.EventTime,
                format: Format,
                decoderReuseEvaluation: DecoderReuseEvaluation?,
            ) = publish()
        })
        handler.post(tick)
    }

    override val positionMs: Long get() = exo.currentPosition + offsetMs
    override val playing: Boolean get() = exo.playWhenReady
    override val buffering: Boolean get() = exo.playbackState == Player.STATE_BUFFERING

    override fun seekTo(positionMs: Long) {
        exo.seekTo((positionMs - offsetMs).coerceAtLeast(0))
        mark()
    }
    override fun play() = exo.play()
    override fun pause() = exo.pause()
    override fun setRate(rate: Float) = exo.setPlaybackSpeed(rate)

    override fun load(source: MediaSource, startAtMs: Long) {
        offsetMs = source.offsetMs
        error = null
        decoder = null
        takeSidecars(source.sidecarSubtitles)
        val item = MediaItem.Builder().setUri(source.masterUrl).setMimeType(MimeTypes.APPLICATION_M3U8).build()
        exo.setMediaItem(item, (startAtMs - offsetMs).coerceAtLeast(0))
        exo.prepare()
        mark()
        publish()
    }

    /** What the video decoder had taken and given back when the position last jumped. */
    private fun mark() {
        val counters = exo.videoDecoderCounters?.apply { ensureUpdated() }
        markCounters = counters
        markInputs = counters?.queuedInputBufferCount ?: 0
        markFrames = counters?.frames ?: 0
    }

    /** Swaps a video decoder that keeps taking samples without a frame since the last jump for the next one. */
    private fun watchDecoder(counters: DecoderCounters?) {
        val name = decoder
        val fresh = counters !== markCounters
        val stuck = name != null && counters != null && exo.playbackState == Player.STATE_BUFFERING &&
            (exo.totalBufferedDuration >= STALL_BUFFER_MS || !exo.isLoading) &&
            counters.queuedInputBufferCount > (if (fresh) 0 else markInputs) &&
            counters.frames == (if (fresh) 0 else markFrames)
        if (!stuck) {
            stallSince = 0
            return
        }
        val now = SystemClock.elapsedRealtime()
        if (stallSince == 0L) stallSince = now
        if (now - stallSince < STALL_MS) return
        Log.w("JuntosPlayer", "$name gave no frame back, trying the next decoder")
        stallSince = 0
        stalled += name!!
        decoder = null
        exo.stop()
        exo.prepare()
    }

    override fun setSidecarSubtitles(subtitles: List<SidecarSubtitle>) {
        takeSidecars(subtitles)
        publish()
    }

    /** The room's subtitles, fetched once per URL, keeping the pick by language across lists. */
    private fun takeSidecars(subtitles: List<SidecarSubtitle>) {
        sidecars = subtitles.mapIndexed { i, s -> SubtitleTrack(i, s.label, s.language, s.url, fetched[s.url]) }
        sidecars.filter { it.cues == null }.forEach { fetch(it.url!!) }
        if ((subtitleIndex ?: IMPORTED_FROM) < IMPORTED_FROM) {
            val (language, label) = subtitlePick!!
            subtitleIndex = (sidecars.firstOrNull { sameLanguage(it.language, language) && it.label == label }
                ?: sidecars.firstOrNull { sameLanguage(it.language, language) }
                ?: sidecars.firstOrNull { language == null && it.label == label })?.index
        }
    }

    override fun selectAudio(index: Int) {
        val ref = audioRefs.getOrNull(index) ?: return
        audioPick = ref.format.language to ref.format.label
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(ref.group.mediaTrackGroup, ref.track))
            .build()
    }

    override fun selectSubtitle(index: Int?) {
        val track = index?.let { i -> subtitleTracks().firstOrNull { it.index == i } }
        subtitleIndex = track?.index
        subtitlePick = track?.let { it.language to it.label }
        publish()
    }

    override fun setSubtitleDelay(ms: Long) {
        delayMs = ((ms.toDouble() / DELAY_STEP_MS).roundToLong() * DELAY_STEP_MS).coerceIn(-DELAY_MAX_MS, DELAY_MAX_MS)
        publish()
    }

    override fun importSubtitle(name: String, text: String): Int? {
        val cues = parseSubtitles(text)
        if (cues.isEmpty()) return null
        val track = SubtitleTrack(IMPORTED_FROM + imported.size, name, null, null, cues)
        imported += track
        selectSubtitle(track.index)
        return track.index
    }

    override fun selectQuality(index: Int?) {
        val ref = index?.let { qualityRefs.getOrNull(it) }
        val params = exo.trackSelectionParameters.buildUpon()
        if (ref == null) {
            params.clearOverridesOfType(C.TRACK_TYPE_VIDEO)
        } else {
            params.setOverrideForType(TrackSelectionOverride(ref.group.mediaTrackGroup, ref.track))
        }
        exo.trackSelectionParameters = params.build()
    }

    override fun release() {
        released = true
        handler.removeCallbacks(tick)
        exo.release()
    }

    internal fun attach(view: SurfaceView) {
        if (!released) exo.setVideoSurfaceView(view)
    }

    /** The surface can outlive the player when the screen tears down after the room let go. */
    internal fun detach(view: SurfaceView) {
        if (!released) exo.clearVideoSurfaceView(view)
    }

    private fun subtitleTracks() = sidecars + imported

    private fun fetch(url: String) {
        client.newCall(Request.Builder().url(url).build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {}
            override fun onResponse(call: Call, response: Response) {
                val cues = response.use { if (it.isSuccessful) parseSubtitles(it.body!!.string()) else null } ?: return
                handler.post {
                    fetched[url] = cues
                    sidecars.filter { it.url == url }.forEach { it.cues = cues }
                    publish()
                }
            }
        })
    }

    private fun indexTracks(tracks: Tracks) {
        fun refs(type: Int) = tracks.groups.filter { it.type == type }
            .flatMap { group -> (0 until group.length).filter(group::isTrackSupported).map { TrackRef(group, it) } }
        audioRefs = refs(C.TRACK_TYPE_AUDIO)
        qualityRefs = refs(C.TRACK_TYPE_VIDEO).sortedByDescending { it.format.height }
        audioPick?.let { (language, label) ->
            val again = audioRefs.firstOrNull { sameLanguage(it.format.language, language) && it.format.label == label }
                ?: audioRefs.firstOrNull { sameLanguage(it.format.language, language) }
            if (again != null && !again.selected) {
                exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
                    .setOverrideForType(TrackSelectionOverride(again.group.mediaTrackGroup, again.track))
                    .build()
            }
        }
        publish()
    }

    private fun publish() {
        val overrides = exo.trackSelectionParameters.overrides
        val counters = exo.videoDecoderCounters?.apply { ensureUpdated() }
        watchDecoder(counters)
        val duration = exo.duration
        val position = positionMs
        val subtitles = subtitleTracks()
        _cues.value = subtitles.firstOrNull { it.index == subtitleIndex }?.cues?.let { activeCues(it, position - delayMs) }.orEmpty()
        _snapshot.value = PlayerSnapshot(
            durationMs = if (duration == C.TIME_UNSET) 0 else duration + offsetMs,
            positionMs = position,
            bufferedAheadMs = exo.totalBufferedDuration,
            playing = playing,
            buffering = buffering,
            error = error,
            videoCodec = exo.videoFormat?.let { it.codecs ?: it.sampleMimeType },
            videoDecoder = decoder,
            audio = audioRefs.mapIndexed { i, ref ->
                TrackOption(i, audioTrackLabel(ref.format.label, ref.format.language, i), ref.format.language, ref.selected)
            },
            subtitles = subtitles.map { track ->
                val label = track.label.ifBlank { track.language?.let(::languageLabel) ?: track.language ?: (track.index + 1).toString() }
                TrackOption(track.index, label, track.language, track.index == subtitleIndex)
            },
            qualities = qualityRefs.mapIndexed { i, ref ->
                val format = ref.format
                val label = if (format.height > 0) "${format.height}p" else "${format.bitrate / 1000} kbps"
                TrackOption(i, label, selected = overrides[ref.group.mediaTrackGroup]?.trackIndices?.contains(ref.track) == true)
            },
            droppedFrames = counters?.droppedBufferCount?.toLong() ?: 0,
            decodedFrames = counters?.frames?.toLong() ?: 0,
            subtitleDelayMs = delayMs,
        )
    }

    private val DecoderCounters.frames get() = renderedOutputBufferCount + skippedOutputBufferCount + droppedBufferCount
    private val TrackRef.format get() = group.getTrackFormat(track)
    private val TrackRef.selected get() = group.isTrackSelected(track)
}
