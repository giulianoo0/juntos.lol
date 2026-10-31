package lol.juntos.app

import android.net.Uri
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performImeAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.test.platform.app.InstrumentationRegistry
import lol.juntos.app.room.SettingsPanel
import lol.juntos.design.JuntosTheme
import lol.juntos.player.FakePlayer
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.io.File

class SettingsPanelTest {
    @get:Rule
    val rule = createComposeRule()

    private val player = FakePlayer()
    private val notices = mutableListOf<String>()
    private var picked: Uri? = null

    private val registry = object : ActivityResultRegistry() {
        override fun <I, O> onLaunch(requestCode: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
            dispatchResult(requestCode, picked)
        }
    }

    private fun show() = rule.setContent {
        CompositionLocalProvider(LocalActivityResultRegistryOwner provides object : ActivityResultRegistryOwner {
            override val activityResultRegistry = registry
        }) {
            JuntosTheme { SettingsPanel(player, onNotice = { notices += it }) }
        }
    }

    private fun file(name: String, text: String): Uri {
        val dir = InstrumentationRegistry.getInstrumentation().targetContext.cacheDir
        return Uri.fromFile(File(dir, name).apply { writeText(text) })
    }

    @Test
    fun pickingAnAudioTrackSwitchesThePlayerToIt() {
        show()
        rule.onNodeWithText("Português").performClick()
        assertEquals(1, player.snapshot.value.audio.single { it.selected }.index)
        rule.onNodeWithText("Português").assertIsSelected()
    }

    @Test
    fun pickingASubtitleAndThenOffSwitchesThePlayer() {
        show()
        rule.onNodeWithText("Legendas").performClick()
        rule.onNodeWithText("Português").performClick()
        assertEquals(0, player.snapshot.value.subtitles.single { it.selected }.index)
        rule.onNodeWithText("Desligadas").performClick()
        assertEquals(emptyList<Int>(), player.snapshot.value.subtitles.filter { it.selected }.map { it.index })
    }

    @Test
    fun anImportedFileBecomesTheChosenSubtitle() {
        picked = file("meu filme.srt", "1\n00:00:01,000 --> 00:00:02,000\nOi\n")
        show()
        rule.onNodeWithText("Legendas").performClick()
        rule.onNodeWithText("Importar arquivo").performClick()
        rule.waitUntil(3_000) { notices.isNotEmpty() }
        assertEquals(listOf("Legenda importada"), notices)
        rule.onNodeWithText("meu filme.srt").assertIsSelected()
    }

    @Test
    fun aFileWithoutCuesIsRefused() {
        picked = file("nada.txt", "isso não é legenda")
        show()
        rule.onNodeWithText("Legendas").performClick()
        rule.onNodeWithText("Importar arquivo").performClick()
        rule.waitUntil(3_000) { notices.isNotEmpty() }
        assertEquals(listOf("Esse arquivo de legenda não é suportado. Use SRT, ASS, SSA ou VTT."), notices)
    }

    @Test
    fun theDelayGoesUpAndDownAQuarterSecondPerTap() {
        show()
        rule.onNodeWithText("Legendas").performClick()
        rule.onNodeWithContentDescription("Mais atraso").performClick()
        rule.onNodeWithContentDescription("Mais atraso").performClick()
        rule.onNodeWithText("+0,50 s").assertExists()
        rule.onNodeWithContentDescription("Menos atraso").performClick()
        rule.onNodeWithText("+0,25 s").assertExists()
        assertEquals(250L, player.snapshot.value.subtitleDelayMs)
    }

    @Test
    fun holdingMinusKeepsStepping() {
        show()
        rule.onNodeWithText("Legendas").performClick()
        rule.onNodeWithContentDescription("Menos atraso").assertExists()
        rule.mainClock.autoAdvance = false
        rule.onNodeWithContentDescription("Menos atraso").performTouchInput { down(center) }
        rule.mainClock.advanceTimeBy(450 + 120 * 3 + 10)
        rule.onNodeWithContentDescription("Menos atraso").performTouchInput { up() }
        rule.mainClock.autoAdvance = true
        rule.waitForIdle()
        assertEquals(true, player.snapshot.value.subtitleDelayMs <= -750)
    }

    @Test
    fun theValueOpensAFieldForAnExactNumber() {
        show()
        rule.onNodeWithText("Legendas").performClick()
        rule.onNodeWithText("0,00 s").performClick()
        rule.onNodeWithContentDescription("Atraso da legenda").performTextReplacement("1,25")
        rule.onNodeWithContentDescription("Atraso da legenda").performImeAction()
        rule.waitUntil(2_000) { rule.onAllNodes(hasText("+1,25 s")).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(1_250L, player.snapshot.value.subtitleDelayMs)
    }
}
