package lol.juntos.player

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
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
import androidx.media3.common.text.Cue
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.OkHttpClient

/** Hardware first, then the platform's software decoder (c2.android.*): what the phone's browser won't do for HEVC. */
@OptIn(UnstableApi::class)
private val preferHardware = MediaCodecSelector { mimeType, secure, tunneling ->
    MediaCodecUtil.getDecoderInfos(mimeType, secure, tunneling).sortedBy { !it.hardwareAccelerated }
}

private const val TICK_MS = 200L

private data class TrackRef(val group: Tracks.Group, val track: Int)

/**
 * The room's player on Media3: HLS over the app's OkHttp client (its cookie jar included).
 * Every call belongs on the main thread.
 */
@OptIn(UnstableApi::class)
class Media3Player(context: Context, client: OkHttpClient = OkHttpClient()) : JuntosPlayer {
    private val _snapshot = MutableStateFlow(PlayerSnapshot())
    override val snapshot: StateFlow<PlayerSnapshot> = _snapshot

    private val _cues = MutableStateFlow<List<Cue>>(emptyList())

    /** The subtitle lines showing now, for the surface to draw. */
    val cues: StateFlow<List<Cue>> = _cues

    private val _videoSize = MutableStateFlow(VideoSize.UNKNOWN)
    val videoSize: StateFlow<VideoSize> = _videoSize

    /** The rendition playing now: what a pinned quality is checked against. */
    val videoFormat: Format? get() = exo.videoFormat

    internal val exo: ExoPlayer = ExoPlayer.Builder(
        context,
        DefaultRenderersFactory(context).setEnableDecoderFallback(true).setMediaCodecSelector(preferHardware),
    )
        .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(client)))
        .setLooper(Looper.getMainLooper())
        .build()

    private var offsetMs = 0L
    private var decoder: String? = null
    private var error: String? = null
    private var audioRefs = emptyList<TrackRef>()
    private var subtitleRefs = emptyList<TrackRef>()
    private var qualityRefs = emptyList<TrackRef>()

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
            override fun onCues(cueGroup: CueGroup) {
                _cues.value = cueGroup.cues
            }
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

    override fun seekTo(positionMs: Long) = exo.seekTo((positionMs - offsetMs).coerceAtLeast(0))
    override fun play() = exo.play()
    override fun pause() = exo.pause()
    override fun setRate(rate: Float) = exo.setPlaybackSpeed(rate)

    override fun load(source: MediaSource, startAtMs: Long) {
        offsetMs = source.offsetMs
        error = null
        decoder = null
        val item = MediaItem.Builder()
            .setUri(source.masterUrl)
            .setMimeType(MimeTypes.APPLICATION_M3U8)
            .setSubtitleConfigurations(
                source.sidecarSubtitles.map {
                    MediaItem.SubtitleConfiguration.Builder(Uri.parse(it.url))
                        .setMimeType(it.mimeType)
                        .setLanguage(it.language)
                        .setLabel(it.label)
                        .build()
                },
            )
            .build()
        exo.setMediaItem(item, (startAtMs - offsetMs).coerceAtLeast(0))
        exo.prepare()
        publish()
    }

    override fun selectAudio(index: Int) {
        val ref = audioRefs.getOrNull(index) ?: return
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(ref.group.mediaTrackGroup, ref.track))
            .build()
    }

    override fun selectSubtitle(index: Int?) {
        val ref = index?.let { subtitleRefs.getOrNull(it) }
        val params = exo.trackSelectionParameters.buildUpon()
        if (ref == null) {
            params.clearOverridesOfType(C.TRACK_TYPE_TEXT).setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        } else {
            params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
                .setOverrideForType(TrackSelectionOverride(ref.group.mediaTrackGroup, ref.track))
        }
        exo.trackSelectionParameters = params.build()
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
        handler.removeCallbacks(tick)
        exo.release()
    }

    private fun indexTracks(tracks: Tracks) {
        fun refs(type: Int) = tracks.groups.filter { it.type == type }
            .flatMap { group -> (0 until group.length).filter(group::isTrackSupported).map { TrackRef(group, it) } }
        audioRefs = refs(C.TRACK_TYPE_AUDIO)
        subtitleRefs = refs(C.TRACK_TYPE_TEXT)
        qualityRefs = refs(C.TRACK_TYPE_VIDEO).sortedByDescending { it.format.height }
        publish()
    }

    private fun publish() {
        val overrides = exo.trackSelectionParameters.overrides
        val counters = exo.videoDecoderCounters
        val duration = exo.duration
        _snapshot.value = PlayerSnapshot(
            durationMs = if (duration == C.TIME_UNSET) 0 else duration + offsetMs,
            positionMs = positionMs,
            bufferedAheadMs = exo.totalBufferedDuration,
            playing = playing,
            buffering = buffering,
            error = error,
            videoCodec = exo.videoFormat?.let { it.codecs ?: it.sampleMimeType },
            videoDecoder = decoder,
            audio = audioRefs.mapIndexed { i, ref ->
                TrackOption(i, audioTrackLabel(ref.format.label, ref.format.language, i), ref.format.language, ref.selected)
            },
            subtitles = subtitleRefs.mapIndexed { i, ref ->
                val format = ref.format
                val label = format.label?.takeIf { it.isNotBlank() }
                    ?: format.language?.let(::languageLabel) ?: format.language ?: (i + 1).toString()
                TrackOption(i, label, format.language, ref.selected && !exo.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
            },
            qualities = qualityRefs.mapIndexed { i, ref ->
                val format = ref.format
                val label = if (format.height > 0) "${format.height}p" else "${format.bitrate / 1000} kbps"
                TrackOption(i, label, selected = overrides[ref.group.mediaTrackGroup]?.trackIndices?.contains(ref.track) == true)
            },
            droppedFrames = counters?.droppedBufferCount?.toLong() ?: 0,
            decodedFrames = counters?.let { it.renderedOutputBufferCount + it.skippedOutputBufferCount + it.droppedBufferCount }?.toLong() ?: 0,
        )
    }

    private val TrackRef.format get() = group.getTrackFormat(track)
    private val TrackRef.selected get() = group.isTrackSelected(track)
}
