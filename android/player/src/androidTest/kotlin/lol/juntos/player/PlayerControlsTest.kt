package lol.juntos.player

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.click
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import lol.juntos.design.JuntosTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PlayerControlsTest {
    @get:Rule
    val rule = createComposeRule()

    private val player = FakePlayer(durationMs = 596_000).apply { seekTo(60_000) }
    private val intents = RecordingIntents()
    private var fullscreen by mutableStateOf(false)

    private fun show() {
        rule.setContent {
            JuntosTheme(dark = true) {
                Box(Modifier.fillMaxWidth().height(240.dp)) {
                    PlayerControls(player, intents, fullscreen, { fullscreen = it })
                }
            }
        }
        rule.mainClock.advanceTimeBy(100)
    }

    /** Past the double-tap window and any enter or exit animation. */
    private fun settle() = rule.mainClock.advanceTimeBy(500)

    private val gestures get() = rule.onNodeWithTag("player-gestures")
    private val controls get() = rule.onNodeWithTag("player-controls")

    @Test
    fun aTapHidesTheControlsAndAnotherBringsThemBack() {
        show()
        controls.assertIsDisplayed()
        gestures.performTouchInput { click(percentOffset(0.5f, 0.2f)) }
        settle()
        controls.assertDoesNotExist()
        gestures.performTouchInput { click(percentOffset(0.5f, 0.2f)) }
        settle()
        controls.assertIsDisplayed()
    }

    @Test
    fun theControlsHideThemselvesThreeSecondsIntoPlaying() {
        player.play()
        show()
        rule.mainClock.advanceTimeBy(2_500)
        controls.assertIsDisplayed()
        rule.mainClock.advanceTimeBy(1_500)
        controls.assertDoesNotExist()
    }

    @Test
    fun pausedTheControlsStay() {
        show()
        rule.mainClock.advanceTimeBy(6_000)
        controls.assertIsDisplayed()
    }

    @Test
    fun aDoubleTapOnTheRightSkipsTenSecondsAhead() {
        show()
        gestures.performTouchInput { doubleClick(centerRight.copy(x = width * 0.85f)) }
        settle()
        assertEquals(listOf(70_000L), intents.seeks)
        rule.onNodeWithText("+10 s").assertIsDisplayed()
    }

    @Test
    fun aDoubleTapOnTheLeftSkipsTenSecondsBack() {
        show()
        gestures.performTouchInput { doubleClick(centerLeft.copy(x = width * 0.15f)) }
        settle()
        assertEquals(listOf(50_000L), intents.seeks)
        rule.onNodeWithText("−10 s").assertIsDisplayed()
    }

    @Test
    fun playAsksAtTheCurrentPositionAndTheIconTurnsToPause() {
        show()
        rule.onNodeWithContentDescription("Reproduzir").performClick()
        settle()
        assertEquals(listOf(60_000L), intents.plays)
        rule.onNodeWithContentDescription("Pausar").assertIsDisplayed()
    }

    @Test
    fun pauseAsksAtTheCurrentPosition() {
        player.play()
        show()
        rule.onNodeWithContentDescription("Pausar").performClick()
        settle()
        assertEquals(listOf(60_000L), intents.pauses)
    }

    @Test
    fun theBarIsAFullTouchTarget() {
        show()
        rule.onNodeWithTag("player-seekbar").assertHeightIsAtLeast(44.dp)
    }

    @Test
    fun draggingTheBarPreviewsTheTimeAndSeeksOnRelease() {
        show()
        val bar = rule.onNodeWithTag("player-seekbar")
        bar.performTouchInput {
            down(centerLeft)
            moveTo(center)
        }
        rule.mainClock.advanceTimeBy(100)
        rule.onNodeWithTag("player-scrub-preview").assertIsDisplayed()
        rule.onNodeWithText(timecode(298_000)).assertExists()
        assertTrue(intents.seeks.isEmpty())
        bar.performTouchInput { up() }
        settle()
        assertEquals(1, intents.seeks.size)
        assertTrue("sought ${intents.seeks}", intents.seeks.single() in 295_000L..301_000L)
        rule.onNodeWithTag("player-scrub-preview").assertDoesNotExist()
    }

    @Test
    fun theFullscreenButtonAsksForFullscreenAndBack() {
        show()
        rule.onNodeWithContentDescription("Tela cheia").performClick()
        settle()
        assertTrue(fullscreen)
        rule.onNodeWithContentDescription("Sair da tela cheia").performClick()
        settle()
        assertEquals(false, fullscreen)
    }
}

class RecordingIntents : PlayerIntents {
    val plays = mutableListOf<Long>()
    val pauses = mutableListOf<Long>()
    val seeks = mutableListOf<Long>()
    override fun play(positionMs: Long) { plays += positionMs }
    override fun pause(positionMs: Long) { pauses += positionMs }
    override fun seek(positionMs: Long) { seeks += positionMs }
}
