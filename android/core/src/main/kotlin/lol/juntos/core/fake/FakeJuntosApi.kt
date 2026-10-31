package lol.juntos.core.fake

import lol.juntos.core.api.JuntosApi
import lol.juntos.core.model.CreatedRoom
import lol.juntos.core.model.PublicConfig
import lol.juntos.core.model.RoomInfo
import lol.juntos.core.model.RoomPreview

class FakeJuntosApi(private val rooms: MutableMap<String, RoomInfo> = mutableMapOf()) : JuntosApi {
    private var next = 0

    override suspend fun config() = PublicConfig()
    override suspend fun verifyHuman(token: String) {}

    override suspend fun createRoom(nickname: String, name: String, password: String?): CreatedRoom {
        val id = "FAKE%04d".format(next++)
        rooms[id] = RoomInfo(id = id, name = name.ifBlank { null }, joinMode = if (password != null) "password" else "open")
        return CreatedRoom(id = id, ownerToken = "owner-$id", nickname = nickname, name = name)
    }

    override suspend fun room(roomId: String) = rooms[roomId] ?: RoomInfo(id = roomId)
    override suspend fun preview(roomId: String) = RoomPreview(id = roomId, name = rooms[roomId]?.name)
    override suspend fun join(roomId: String, password: String?): String? = password?.let { "ticket-$roomId" }
}
