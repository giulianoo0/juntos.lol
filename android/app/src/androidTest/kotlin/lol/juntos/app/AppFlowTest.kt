package lol.juntos.app

import android.content.res.Configuration
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import lol.juntos.core.fake.FakeSyncSession
import lol.juntos.core.fake.FakeSyncSessionFactory
import lol.juntos.core.model.Member
import lol.juntos.core.sync.SessionRequest
import lol.juntos.core.sync.SyncSessionFactory
import lol.juntos.design.JuntosTheme
import lol.juntos.player.FakePlayer
import lol.juntos.player.PlayerFactory
import lol.juntos.update.Release
import lol.juntos.update.UpdateState
import lol.juntos.update.Updater
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class AppFlowTest {
    @get:Rule
    val rule = createComposeRule()

    private val player = FakePlayer()
    private val fakes = FakeSyncSessionFactory()
    private val requests = mutableListOf<SessionRequest>()
    private val graph = object : AppGraph by FakeAppGraph() {
        override val players = PlayerFactory { player }
        override val sessions = SyncSessionFactory { request -> requests += request; fakes.open(request) }
    }
    private val session: FakeSyncSession get() = fakes.opened.last()

    private fun launch(linked: String? = null) = rule.setContent {
        JuntosTheme { JuntosNavHost(graph = graph, linkedRoom = linked, onLinkedRoomOpened = {}) }
    }

    private fun waitFor(text: String) = rule.waitUntil(5_000) { rule.onAllNodes(hasText(text)).fetchSemanticsNodes().isNotEmpty() }

    private fun enterCreatedRoom() {
        rule.onNodeWithText("Criar sala").performClick()
        rule.onNodeWithContentDescription("Nome da sala").performTextInput("Cinema")
        rule.onNodeWithText("Criar").performClick()
        waitFor("Sala de teste")
    }

    @Test
    fun aNewerApkOnTheReleaseIsOneTapFromTheHome() {
        val updater = object : Updater {
            override val state = MutableStateFlow<UpdateState>(UpdateState.Available(Release(2, "0.1.1", "https://example.invalid/juntos.apk", "00")))
            var installs = 0
            override suspend fun check() {}
            override suspend fun install() { installs++ }
        }
        val updating = object : AppGraph by graph { override val updater: Updater = updater }
        rule.setContent { JuntosTheme { JuntosNavHost(graph = updating, linkedRoom = null, onLinkedRoomOpened = {}) } }
        rule.onNodeWithText("Atualizar para 0.1.1").performClick()
        rule.waitUntil(3_000) { updater.installs == 1 }
    }

    @Test
    fun creatingARoomOpensItAsItsOwner() {
        launch()
        enterCreatedRoom()
        val request = requests.single()
        assertEquals("FAKE0000", request.roomId)
        assertEquals("owner-FAKE0000", request.ownerToken)
        rule.onNodeWithContentDescription("Sair").assertExists()
    }

    @Test
    fun aRoomWithAPasswordAsksForItInThePopover() {
        launch()
        rule.onNodeWithText("Criar sala").performClick()
        rule.onNodeWithContentDescription("Senha").performClick()
        rule.onNode(hasContentDescription("Senha da sala")).performTextInput("1234")
        rule.onNodeWithText("Criar").performClick()
        waitFor("Sala de teste")
    }

    @Test
    fun aCodeTypedOnTheHomeEntersThatRoom() {
        launch()
        rule.onNodeWithContentDescription("Código da sala").performTextInput("abcd1234")
        rule.onNodeWithText("Entrar").performClick()
        waitFor("Sala de teste")
        assertEquals("ABCD1234", requests.single().roomId)
    }

    @Test
    fun aLinkOpensTheRoomStraightAway() {
        launch(linked = "LINK0001")
        waitFor("Sala de teste")
        assertEquals("LINK0001", requests.single().roomId)
    }

    @Test
    fun settingsSwitchBetweenAudioAndSubtitles() {
        launch()
        enterCreatedRoom()
        rule.onNodeWithContentDescription("Configurações").performClick()
        rule.onNodeWithText("Áudio").assertIsSelected()
        rule.onNodeWithText("Português").performClick()
        assertEquals(1, player.snapshot.value.audio.single { it.selected }.index)
        rule.onNodeWithText("Legendas").performClick()
        rule.onNodeWithText("Legendas").assertIsSelected()
        rule.onNodeWithText("Desligadas").assertExists()
        rule.onNodeWithText("Português").performClick()
        assertEquals(0, player.snapshot.value.subtitles.single { it.selected }.index)
    }

    @Test
    fun someoneWhoArrivesGetsATileAndLosesItOnLeaving() {
        launch()
        enterCreatedRoom()
        rule.runOnIdle { session.join(Member(id = "ana", nickname = "Ana", avatar = "fox.bowtie")) }
        rule.onNodeWithText("Ana").assertExists()
        rule.runOnIdle { session.drop("ana") }
        rule.waitUntil(3_000) { rule.onAllNodes(hasText("Ana")).fetchSemanticsNodes().isEmpty() }
    }

    @Test
    fun lyingThePhoneDownGivesTheWholeScreenToTheVideo() {
        var landscape by mutableStateOf(false)
        rule.setContent {
            val base = LocalConfiguration.current
            val config = Configuration(base).apply {
                orientation = if (landscape) Configuration.ORIENTATION_LANDSCAPE else Configuration.ORIENTATION_PORTRAIT
            }
            CompositionLocalProvider(LocalConfiguration provides config) {
                JuntosTheme { JuntosNavHost(graph = graph, linkedRoom = "LINK0001", onLinkedRoomOpened = {}) }
            }
        }
        waitFor("Sala de teste")
        landscape = true
        rule.waitUntil(3_000) { rule.onAllNodes(hasText("Sala de teste")).fetchSemanticsNodes().isEmpty() }
        rule.onNodeWithContentDescription("Sair").assertDoesNotExist()
        landscape = false
        waitFor("Sala de teste")
    }

    @Test
    fun pinningSomeoneBringsThemToTheTopInView() {
        launch(linked = "LINK0001")
        waitFor("Sala de teste")
        rule.runOnIdle {
            session.join(Member(id = "ana", nickname = "Ana"))
            session.join(Member(id = "bia", nickname = "Bia"))
            session.join(Member(id = "caio", nickname = "Caio"))
        }
        rule.onAllNodes(hasContentDescription("Fixar"))[3].performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Caio").assertIsDisplayed()
        rule.onNodeWithContentDescription("Desafixar").assertIsDisplayed()
    }

    @Test
    fun aMessageSentInTheChatShowsUpThere() {
        launch()
        enterCreatedRoom()
        rule.onNodeWithContentDescription("Chat").performClick()
        rule.onNodeWithContentDescription("Mensagem").performTextInput("oi gente")
        rule.onNodeWithContentDescription("Enviar").performClick()
        rule.onNodeWithText("oi gente").assertExists()
        assertEquals("oi gente", session.state.value.chat.last().text)
    }
}
