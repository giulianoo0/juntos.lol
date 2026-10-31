package lol.juntos.core.api

import lol.juntos.core.model.CreatedRoom
import lol.juntos.core.model.PublicConfig
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.RoomPreview
import lol.juntos.core.model.Seat

/** The HTTP side of juntos.lol. Calls throw [ApiException] with the server's error code. */
interface JuntosApi {
    suspend fun config(): PublicConfig

    /** Spends a Turnstile token on /api/human; the day-long `ss_human` cookie lands in the shared jar. */
    suspend fun verifyHuman(token: String)

    suspend fun createRoom(nickname: String, name: String = "", password: String? = null): CreatedRoom

    suspend fun room(roomId: String): RoomInfo

    /** The room as a member reads it: behind a password or approval, only a seat gets an answer. */
    suspend fun room(roomId: String, seat: Seat): RoomInfo = room(roomId)

    suspend fun preview(roomId: String): RoomPreview

    /** The ticket the socket's hello carries into a password room (the server mints one for any room). */
    suspend fun join(roomId: String, password: String? = null): String?

    /** Points the room at a source this phone produces (`kind: "local"`); answers the new media generation. */
    suspend fun changeLocalSource(roomId: String, seat: Seat, title: String, durationMs: Long, localCopy: LocalCopy?): Int =
        throw UnsupportedOperationException()

    /** Someone needs the bucket: the claim to upload this phone's cache with. */
    suspend fun promoteLocal(roomId: String, seat: Seat): Promotion = throw UnsupportedOperationException()
}

/** What another app opens to play its own copy of a source this phone produces. */
@kotlinx.serialization.Serializable
data class LocalCopy(val kind: String, val url: String? = null, val videoId: String? = null, val magnet: String? = null, val index: Int? = null)

/** The upload a promote hands over: the claim the producer signs its runs with. */
@kotlinx.serialization.Serializable
data class Promotion(val claim: String, val mediaGeneration: Int)

class ApiException(val status: Int, val code: String) : Exception(code)
