package lol.juntos.app.room

import android.util.Log
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.api.LocalCopy
import lol.juntos.core.media.regionFor
import lol.juntos.core.media.regionHolds
import lol.juntos.core.model.MediaRegion
import lol.juntos.core.model.Seat
import lol.juntos.core.sync.SyncSession
import lol.juntos.producer.Producer

/** What this phone hosts: a YouTube video or one file of a torrent it opened. */
sealed interface LocalSource {
    val title: String

    data class Youtube(val url: String, val videoId: String, override val title: String, val durationMs: Long) : LocalSource
    data class Torrent(val id: String, val index: Int, override val title: String, val magnet: String) : LocalSource
}

/** One file a magnet holds, to pick from. */
data class TorrentFile(val index: Int, val path: String, val size: Long)

data class OpenedTorrent(val id: String, val name: String, val magnet: String, val files: List<TorrentFile>)

/** The cache the host plays: regions as the room's, read from the producer every second. */
data class LocalMedia(val key: String, val generation: Int, val durationMs: Long, val regions: List<MediaRegion>, val hlsDir: File)

/**
 * The host's side of a room this phone produces, as web/src/desktop/localRoom.ts does it on the
 * desktop: the source goes into a local cache the host plays, and goes up to the room only while
 * the server says someone needs it (needBrowserMedia), playhead first, until nobody does.
 */
class LocalHost(
    private val producer: Producer,
    private val api: JuntosApi,
    private val session: SyncSession,
    private val roomId: String,
    private val scope: CoroutineScope,
) {
    private val _media = MutableStateFlow<LocalMedia?>(null)
    val media: StateFlow<LocalMedia?> = _media

    private val _preparing = MutableStateFlow(false)
    val preparing: StateFlow<Boolean> = _preparing

    private var poll: Job? = null
    private var watch: Job? = null
    private var followTimer: Job? = null
    /** A guest asked before the cache was ready, or for a newer generation. */
    private var wanted: Int? = null
    private var uploading = false
    private var sentMs: Long? = null
    private var lastFollowAt = 0L
    private var positionMs = 0L

    /** Asks yt-dlp what the link is: title, length and its id. */
    suspend fun resolveYoutube(url: String): LocalSource.Youtube {
        val summary = producer.call("youtube_resolve", mapOf("url" to url)).jsonObject
        if (summary["live"]?.jsonPrimitive?.boolean == true) throw IllegalStateException("live")
        val videoId = summary["videoId"]!!.jsonPrimitive.content
        val title = summary["title"]?.jsonPrimitive?.content?.trim().orEmpty().ifEmpty { videoId }
        return LocalSource.Youtube(url, videoId, title, summary["durationMs"]?.jsonPrimitive?.longOrNull ?: 0)
    }

    suspend fun openTorrent(magnet: String): OpenedTorrent {
        val opened = producer.call("torrent_open", mapOf("magnet" to magnet)).jsonObject
        val files = opened["files"]!!.jsonArray.map {
            val file = it.jsonObject
            TorrentFile(file["index"]!!.jsonPrimitive.int, file["path"]!!.jsonPrimitive.content, file["size"]!!.jsonPrimitive.long)
        }
        return OpenedTorrent(opened["id"]!!.jsonPrimitive.content, opened["name"]!!.jsonPrimitive.content, magnet, files)
    }

    /** Points the room at [source] and starts writing it into the cache; the previous one stops. */
    suspend fun host(seat: Seat, source: LocalSource) {
        _preparing.value = true
        try {
            val copy = when (source) {
                is LocalSource.Youtube -> LocalCopy(kind = "youtube", url = source.url, videoId = source.videoId)
                is LocalSource.Torrent -> LocalCopy(kind = "torrent", magnet = source.magnet, index = source.index)
            }
            val duration = (source as? LocalSource.Youtube)?.durationMs ?: 0
            stopCurrent()
            val generation = api.changeLocalSource(roomId, seat, source.title, duration, copy)
            val prepare = when (source) {
                is LocalSource.Youtube -> mapOf("kind" to "youtube", "url" to source.url, "videoId" to source.videoId, "title" to source.title)
                is LocalSource.Torrent -> mapOf("kind" to "torrent", "id" to source.id, "index" to source.index, "title" to source.title)
            }
            val meta = producer.call("local_prepare", mapOf("source" to prepare)).jsonObject
            val key = meta["key"]!!.jsonPrimitive.content
            val hls = File(producer.call("hls_dir", mapOf("key" to key)).jsonPrimitive.content)
            _media.value = LocalMedia(key, generation, meta["durationMs"]?.jsonPrimitive?.longOrNull ?: duration, emptyList(), hls)
            session.announceSource(if (source is LocalSource.Youtube) "youtube" else "torrent")
            scope.launch {
                runCatching {
                    producer.call(
                        "local_subtitles",
                        mapOf("key" to key, "roomId" to roomId, "mediaGeneration" to generation, "memberId" to seat.memberId, "capability" to seat.capability),
                    )
                }.onFailure { Log.w(TAG, "subtitles", it) }
            }
            poll = scope.launch { pollRegions(key) }
            wanted?.let { if (it == generation) need(seat, generation) }
        } finally {
            _preparing.value = false
        }
    }

    private suspend fun pollRegions(key: String) {
        while (scope.isActive) {
            val regions = runCatching { producer.call("local_regions", mapOf("key" to key)).jsonArray }.getOrNull()
            if (regions != null) {
                if (lol.juntos.app.BuildConfig.DEBUG) Log.d(TAG, "regions $regions")
                _media.value = _media.value?.takeIf { it.key == key }?.copy(regions = regions.map(::region))
            }
            delay(POLL_MS)
        }
    }

    private fun region(element: kotlinx.serialization.json.JsonElement): MediaRegion {
        val r = element.jsonObject
        return MediaRegion(
            n = r["n"]!!.jsonPrimitive.int,
            startMs = r["startMs"]!!.jsonPrimitive.long,
            producedMs = r["producedMs"]!!.jsonPrimitive.long,
            growing = r["growing"]?.jsonPrimitive?.boolean ?: false,
        )
    }

    /** The master for the region holding [positionMs], written next to the playlists so their names resolve. */
    suspend fun master(positionMs: Long, current: Int?): Pair<File, MediaRegion>? {
        val media = _media.value ?: return null
        val n = regionFor(media.regions, positionMs, current) ?: return null
        val region = media.regions.first { it.n == n }
        if (region.producedMs <= 0) return null
        val text = runCatching { producer.call("local_master", mapOf("key" to media.key, "n" to n)).jsonPrimitive.content }.getOrNull() ?: return null
        val file = File(media.hlsDir, "android_r${n}_master.m3u8")
        withContext(kotlinx.coroutines.Dispatchers.IO) { if (!file.exists() || file.readText() != text) file.writeText(text) }
        return file to region
    }

    /** needBrowserMedia: someone here plays from the bucket. */
    fun need(seat: Seat, generation: Int) {
        val media = _media.value
        Log.i(TAG, "needBrowserMedia generation=$generation attached=${media?.generation}")
        if (media == null || media.generation != generation) {
            wanted = generation
            return
        }
        wanted = generation
        scope.launch { promote(seat, media) }
        watch?.cancel()
        // An upload that dies with an error is promoted again; one that stops without one reached the end.
        watch = scope.launch {
            while (isActive) {
                delay(UPLOAD_WATCH_MS)
                val status = runCatching { producer.call("upload_status", mapOf("roomId" to roomId)).jsonObject }.getOrNull() ?: continue
                val active = status["active"]?.jsonPrimitive?.boolean ?: false
                val error = status["error"]?.takeIf { it !is kotlinx.serialization.json.JsonNull }
                if (!active && error != null && _media.value?.generation == generation) promote(seat, _media.value!!)
            }
        }
    }

    private suspend fun promote(seat: Seat, media: LocalMedia) {
        val promotion = runCatching { api.promoteLocal(roomId, seat) }.onFailure { Log.w(TAG, "promote", it) }.getOrNull() ?: return
        Log.i(TAG, "promoted generation=${promotion.mediaGeneration}")
        if (promotion.mediaGeneration != media.generation) return
        runCatching {
            producer.call(
                "upload_start",
                mapOf("key" to media.key, "roomId" to roomId, "claim" to promotion.claim, "mediaGeneration" to media.generation, "positionMs" to (sentMs ?: positionMs)),
            )
            uploading = true
        }.onFailure { Log.w(TAG, "upload_start", it) }
    }

    /** browserMediaIdle: nobody needs the bucket; what went up stays. */
    fun idle() {
        Log.i(TAG, "browserMediaIdle")
        wanted = null
        watch?.cancel()
        if (uploading) scope.launch { runCatching { producer.call("upload_stop", mapOf("roomId" to roomId)) } }
        uploading = false
    }

    /**
     * The room's position moved. A position some region already holds goes now; a seek burst
     * reaches the producer as one follow now and its last one 3 s later.
     */
    fun follow(position: Long) {
        positionMs = position
        val media = _media.value ?: return
        val sent = sentMs
        if (sent != null && kotlin.math.abs(position - sent) < SAME_PLACE_MS) return
        val now = System.currentTimeMillis()
        val held = media.regions.any { regionHolds(it, position) }
        followTimer?.cancel()
        if (held || now - lastFollowAt >= FOLLOW_DEBOUNCE_MS) {
            send(media.key, position)
        } else {
            followTimer = scope.launch {
                delay(FOLLOW_DEBOUNCE_MS - (now - lastFollowAt))
                send(media.key, positionMs)
            }
        }
    }

    private fun send(key: String, position: Long) {
        sentMs = position
        lastFollowAt = System.currentTimeMillis()
        scope.launch { runCatching { producer.call("local_follow", mapOf("key" to key, "positionMs" to position)) }.onFailure { Log.w(TAG, "follow", it) } }
    }

    private suspend fun stopCurrent() {
        val media = _media.value ?: return
        poll?.cancel()
        watch?.cancel()
        followTimer?.cancel()
        _media.value = null
        sentMs = null
        uploading = false
        runCatching { producer.call("upload_stop", mapOf("roomId" to roomId)) }
        runCatching { producer.call("local_stop", mapOf("key" to media.key)) }
    }

    /** Leaving the room: the cache stops filling and nothing more goes up. */
    fun close() {
        session.announceSource(null)
        // The room's scope goes with the screen; the stop must outlive it.
        CoroutineScope(kotlinx.coroutines.Dispatchers.IO + NonCancellable).launch { stopCurrent() }
    }

    private companion object {
        const val TAG = "LocalHost"
        const val POLL_MS = 1_000L
        const val UPLOAD_WATCH_MS = 5_000L
        const val FOLLOW_DEBOUNCE_MS = 3_000L
        const val SAME_PLACE_MS = 2_000L
    }
}
