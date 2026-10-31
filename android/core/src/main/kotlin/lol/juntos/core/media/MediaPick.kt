package lol.juntos.core.media

import lol.juntos.core.model.MediaRegion
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.TrackInfo
import java.net.URLEncoder

private const val REGION_AHEAD_MS = 30_000L

// The server's followBehindMs (internal/worker/remux.go) must not exceed this:
// a position it calls covered that no region here holds is a room that waits forever.
const val REGION_BEHIND_MS = 1_000L

/** The playlist to load for a position, and where its time zero sits on the room's timeline. */
data class MediaPick(val masterUrl: String, val offsetMs: Long, val regionN: Int?)

/** `/media/{id}` or `/media/{id}/k/{key}` on the site, as bundle.ts mediaRoot builds it. */
fun mediaRoot(baseUrl: String, roomId: String, key: String?): String {
    val room = "${baseUrl.trimEnd('/')}/media/${encode(roomId)}"
    return if (key != null) "$room/k/${encode(key)}" else room
}

/** Whether a region holds a position: a growing one, up to 30 s ahead of what it wrote. */
fun regionHolds(region: MediaRegion, ms: Long): Boolean {
    val end = region.startMs + region.producedMs + if (region.growing) REGION_AHEAD_MS else 0
    return ms >= region.startMs - REGION_BEHIND_MS && ms <= end
}

/**
 * The region to load for a position: the one already loaded if it still holds it, else the
 * newest region that does, else the growing one when the position is ahead of it (it will get
 * there), else whatever is loaded.
 */
fun regionFor(regions: List<MediaRegion>, ms: Long, current: Int?): Int? {
    if (regions.isEmpty()) return null
    val loaded = regions.firstOrNull { it.n == current }
    if (loaded != null && regionHolds(loaded, ms)) return loaded.n
    val holding = regions.filter { regionHolds(it, ms) }
    if (holding.isNotEmpty()) return holding.reduce { a, b -> if (b.startMs > a.startMs) b else a }.n
    val growing = regions.firstOrNull { it.growing }
    if (growing != null && ms >= growing.startMs - REGION_BEHIND_MS) return growing.n
    return loaded?.n ?: (growing ?: regions.last()).n
}

/**
 * The version allowed to rebuild the player. A region republishes constantly with nothing to
 * rebuild for, so only a room with no region map reloads on the room's media version.
 */
fun reloadVersion(region: MediaRegion?, version: Int?): Int = if (region != null) 0 else version ?: 0

/** The master to play [positionMs] from, keeping [currentRegion] while it still holds it. */
fun mediaPick(baseUrl: String, room: RoomInfo, positionMs: Long, currentRegion: Int? = null): MediaPick {
    val root = mediaRoot(baseUrl, room.id, room.mediaKey)
    val regions = room.mediaRegions.orEmpty()
    val region = regionFor(regions, positionMs, currentRegion)?.let { n -> regions.first { it.n == n } }
    val master = if (region != null) "r${region.n}_master.m3u8" else "master.m3u8"
    val url = "$root/hls/$master?g=${room.mediaGeneration}&v=${reloadVersion(region, room.mediaVersion)}"
    return MediaPick(url, region?.startMs ?: room.mediaOffsetMs ?: 0, region?.n)
}

/** A shared subtitle track in the room's bucket, or null while the room has no bucket. */
fun subtitleUrl(baseUrl: String, room: RoomInfo, track: TrackInfo, ass: Boolean = false): String? {
    val bucket = room.mediaBaseUrl ?: return null
    val base = if (bucket.startsWith("/")) baseUrl.trimEnd('/') + bucket else bucket
    val version = "g=${room.mediaGeneration}&s=${track.digest ?: room.subsVersion ?: 0}"
    return "$base/subs/sub_${track.index}_${safeLanguage(track.language)}.${if (ass) "ass" else "vtt"}?$version"
}

private val languageTag = Regex("^[A-Za-z0-9_-]+$")

private fun safeLanguage(language: String) =
    if (language.isNotEmpty() && language.length <= 35 && languageTag.matches(language)) language else "und"

private fun encode(value: String) = URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20")
