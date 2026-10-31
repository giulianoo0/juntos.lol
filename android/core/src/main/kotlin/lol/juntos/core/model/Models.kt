package lol.juntos.core.model

import kotlinx.serialization.Serializable

// Mirrors of web/src/types.ts and the Go JSON; unknown fields are ignored (JuntosJson).

@Serializable
data class PlayState(
    val playing: Boolean = false,
    val positionMs: Long = 0,
    val rate: Double = 1.0,
    val serverTimeMs: Long = 0,
)

@Serializable
data class Member(
    val id: String,
    val nickname: String,
    val joinedAt: String = "",
    val mic: Boolean? = null,
    val cam: Boolean? = null,
    val hostMuted: Boolean? = null,
    val hostCamOff: Boolean? = null,
    val accountId: Long? = null,
    val avatar: String? = null,
    val client: String? = null,
)

@Serializable
data class ChatMessage(val author: String, val text: String, val at: String = "")

@Serializable
data class TrackInfo(
    val index: Int,
    val language: String = "",
    val title: String = "",
    val codec: String = "",
    val digest: String? = null,
)

@Serializable
data class MediaRegion(val n: Int, val startMs: Long, val producedMs: Long, val growing: Boolean = false)

@Serializable
data class MemberReadiness(
    val memberId: String,
    val bufferAheadMs: Long = 0,
    val stalled: Boolean = false,
    val ready: Boolean = false,
    val ignored: Boolean = false,
)

@Serializable
data class RoomWaiting(val targetMs: Long = 0, val readiness: List<MemberReadiness> = emptyList())

@Serializable
data class Spotlight(val kind: String, val memberId: String? = null)

@Serializable
data class RoomChapter(val startMs: Long, val endMs: Long, val title: String? = null)

/** What a publish moved, carried by roomUpdated. */
@Serializable
data class MediaSnapshot(
    val mediaGeneration: Int = 0,
    val mediaVersion: Int = 0,
    val mediaOffsetMs: Long = 0,
    val mediaRegions: List<MediaRegion>? = null,
)

/** GET /api/rooms/{id}. */
@Serializable
data class RoomInfo(
    val id: String,
    val name: String? = null,
    val fileName: String = "",
    val status: String = "empty",
    val spotlight: Spotlight? = null,
    val joinMode: String? = null,
    val sourceMemberId: String? = null,
    val sourceOrigin: String? = null,
    val mediaGeneration: Int = 0,
    val mediaVersion: Int? = null,
    val subsVersion: Int? = null,
    val durationMs: Long? = null,
    val mediaOffsetMs: Long? = null,
    val mediaRegions: List<MediaRegion>? = null,
    val gatingEnabled: Boolean? = null,
    val errorMessage: String? = null,
    val controllerId: String = "",
    val audioTracks: List<TrackInfo>? = null,
    val subtitleTracks: List<TrackInfo>? = null,
    val chapters: List<RoomChapter>? = null,
    val memberCount: Int = 0,
    val expiresAt: String = "",
    val mediaBaseUrl: String? = null,
    val mediaKey: String? = null,
    val localSource: Boolean? = null,
)

/** GET /api/config: what the server names for the client. */
@Serializable
data class PublicConfig(val turnstileSiteKey: String? = null)

/** POST /api/rooms. */
@Serializable
data class CreatedRoom(
    val id: String,
    val ownerToken: String,
    val nickname: String = "",
    val name: String = "",
    val status: String = "",
    val expiresAt: String = "",
)

/** GET /api/rooms/{id}/preview: the door before joining. */
@Serializable
data class RoomPreview(
    val id: String = "",
    val name: String? = null,
    val fileName: String = "",
    val joinMode: String? = null,
    val memberCount: Int = 0,
    val nicknames: List<String> = emptyList(),
)

/** The seat the socket's welcome hands out: it reads a locked room and takes the seat back on a reconnect. */
data class Seat(val memberId: String, val capability: String)

/** The controller's subtitle pick, for a viewer to copy. */
@Serializable
data class HostSubtitles(val track: Int, val delayMs: Long = 0)
