package lol.juntos.core.sync

import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import lol.juntos.core.api.HttpJuntosApi
import lol.juntos.core.api.MemoryCookieStorage
import lol.juntos.core.api.PersistentCookieJar
import lol.juntos.core.api.juntosHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

/** Against a running stack: `JUNTOS_LIVE=1 android/gw :core:test` (JUNTOS_BASE_URL, default 127.0.0.1:8090). */
class LiveRoomTest {
    private val base = System.getenv("JUNTOS_BASE_URL") ?: "http://127.0.0.1:8090"

    @Before
    fun onlyAgainstALiveStack() = assumeTrue(System.getenv("JUNTOS_LIVE") == "1")

    @Test
    fun `a new room seats its creator in control and echoes play and pause`() = runBlocking {
        val client = juntosHttpClient(PersistentCookieJar(MemoryCookieStorage()), "JuntosApp/test")
        val api = HttpJuntosApi(base, client)
        val created = api.createRoom("Android", "Teste do app")
        val request = SessionRequest(created.id, created.nickname, ownerToken = created.ownerToken, device = "android-live-test")
        val session = SocketSyncSession(request, base, client, api)
        try {
            val seated = withTimeout(10_000) { session.state.first { it.door == Door.In && it.playState != null && it.room != null } }
            assertTrue(seated.isController)
            assertEquals(created.id, seated.room?.id)
            session.play(1_000)
            withTimeout(10_000) { session.state.first { it.playState?.playing == true } }
            session.pause(2_000)
            val paused = withTimeout(10_000) {
                session.state.first { state -> state.playState?.let { !it.playing && it.positionMs == 2_000L } == true }
            }
            assertEquals(Connection.Open, paused.connection)
        } finally {
            session.leave()
        }
    }
}
