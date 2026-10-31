package lol.juntos.core.media

import lol.juntos.core.model.RoomInfo
import java.net.URLEncoder

/** The playlist to load for a position, and where its time zero sits on the room's timeline. */
data class MediaPick(val masterUrl: String, val offsetMs: Long, val regionN: Int?)

/** `/media/{id}` or `/media/{id}/k/{key}` on the site, as bundle.ts mediaRoot builds it. */
fun mediaRoot(baseUrl: String, roomId: String, key: String?): String {
    val room = "${baseUrl.trimEnd('/')}/media/${encode(roomId)}"
    return if (key != null) "$room/k/${encode(key)}" else room
}

/**
 * The master to play [positionMs] from. Onda 1 ports regionFor (web/src/player/regions.ts)
 * here: a region holding the position wins, the current one is kept while it still holds.
 */
fun mediaPick(baseUrl: String, room: RoomInfo, positionMs: Long, currentRegion: Int? = null): MediaPick {
    val root = mediaRoot(baseUrl, room.id, room.mediaKey)
    val regions = room.mediaRegions.orEmpty()
    if (regions.isEmpty()) return MediaPick("$root/hls/master.m3u8", room.mediaOffsetMs ?: 0, null)
    val holding = regions.filter { positionMs >= it.startMs && positionMs <= it.startMs + it.producedMs }
    val region = holding.firstOrNull { it.n == currentRegion } ?: holding.maxByOrNull { it.startMs } ?: regions.first()
    return MediaPick("$root/hls/r${region.n}_master.m3u8", region.startMs, region.n)
}

private fun encode(value: String) = URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20")
