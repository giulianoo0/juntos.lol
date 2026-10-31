package lol.juntos.core.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import lol.juntos.core.JuntosJson
import lol.juntos.core.model.CreatedRoom
import lol.juntos.core.model.PublicConfig
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.RoomPreview
import lol.juntos.core.model.Seat
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class HttpJuntosApi(baseUrl: String, private val client: OkHttpClient) : JuntosApi {
    private val base = baseUrl.toHttpUrl()

    override suspend fun config(): PublicConfig = read(get(url("api", "config")))

    override suspend fun verifyHuman(token: String) {
        send(post(url("api", "human"), HumanBody(token)))
    }

    override suspend fun createRoom(nickname: String, name: String, password: String?): CreatedRoom {
        val joinMode = if (password.isNullOrEmpty()) "open" else "password"
        return read(post(url("api", "rooms"), CreateRoomBody(nickname, name, joinMode, password.orEmpty())))
    }

    override suspend fun room(roomId: String): RoomInfo = read(get(url("api", "rooms", roomId)))

    override suspend fun room(roomId: String, seat: Seat): RoomInfo = read(
        get(url("api", "rooms", roomId)).newBuilder()
            .header("X-Member-Id", seat.memberId)
            .header("X-Capability", seat.capability)
            .build(),
    )

    override suspend fun preview(roomId: String): RoomPreview =
        read<RoomPreview>(get(url("api", "rooms", roomId, "preview"))).copy(id = roomId)

    override suspend fun join(roomId: String, password: String?): String? =
        read<Ticket>(post(url("api", "rooms", roomId, "join"), JoinBody(password.orEmpty()))).ticket

    private fun url(vararg segments: String): HttpUrl =
        base.newBuilder().apply { segments.forEach(::addPathSegment) }.build()

    private fun get(url: HttpUrl) = Request.Builder().url(url).build()

    private inline fun <reified T> post(url: HttpUrl, body: T) = Request.Builder()
        .url(url)
        .post(JuntosJson.encodeToString(body).toRequestBody(JSON))
        .build()

    private suspend inline fun <reified T> read(request: Request): T = JuntosJson.decodeFromString(send(request))

    private suspend fun send(request: Request): String {
        val reply = client.newCall(request).reply()
        if (!reply.ok) throw ApiException(reply.status, errorCode(reply))
        return reply.body
    }

    private fun errorCode(reply: Reply) =
        runCatching { JuntosJson.decodeFromString<ErrorBody>(reply.body).error }.getOrNull() ?: "http_${reply.status}"

    @Serializable private class HumanBody(val token: String)

    @Serializable private class CreateRoomBody(val nickname: String, val name: String, val joinMode: String, val password: String)

    @Serializable private class JoinBody(val password: String)

    @Serializable private class Ticket(val ticket: String? = null)

    @Serializable private class ErrorBody(val error: String? = null)

    private companion object {
        val JSON = "application/json".toMediaType()
    }
}
