package lol.juntos.player

import android.app.UiAutomation
import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.doubleClick
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosTheme
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Not a check: prints of the controls over a real clip, for the eye. Runs only with
 * `-e screenshots 1`; the PNGs land in the test app's files/shots.
 */
class ControlsScreenshots {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val player = newPlayer()
    private val intents = RecordingIntents()

    @Before
    fun only() = assumeTrue(InstrumentationRegistry.getArguments().getString("screenshots") == "1")

    @After
    fun release() {
        instrumentation.uiAutomation.setRotation(UiAutomation.ROTATION_UNFREEZE)
        onMain { player.release() }
    }

    private fun pausedThreeSecondsIn() {
        onMain {
            player.load(MediaSource("$clipsBase/rich/master.m3u8"))
            player.importSubtitle("prints.srt", "1\n00:00:00,000 --> 00:01:00,000\nTodo mundo <i>junto</i>,\n<font color=\"#ffd400\">no mesmo segundo</font>\n")
            player.play()
        }
        player.snapshot.awaitFirst(20_000) { it.positionMs >= 3_000 }
        onMain { player.pause() }
    }

    private fun shoot(name: String) {
        rule.waitForIdle()
        val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "shots").apply { mkdirs() }
        val shot = instrumentation.uiAutomation.takeScreenshot()
        File(dir, "$name.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test
    fun portrait() {
        pausedThreeSecondsIn()
        rule.setContent {
            JuntosTheme(dark = true) {
                Column(Modifier.fillMaxSize().background(Juntos.colors.frameGround).statusBarsPadding()) {
                    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
                        PlayerSurface(player, Modifier.fillMaxSize())
                        PlayerControls(player, intents, fullscreen = false, onFullscreenChange = {})
                    }
                }
            }
        }
        shoot("controls-portrait")
        rule.onNodeWithTag("player-seekbar").performTouchInput {
            down(centerLeft)
            moveTo(percentOffset(0.62f, 0.5f))
        }
        shoot("controls-portrait-scrub")
        rule.onNodeWithTag("player-seekbar").performTouchInput { cancel() }
    }

    @Test
    fun landscape() {
        instrumentation.uiAutomation.setRotation(UiAutomation.ROTATION_FREEZE_90)
        pausedThreeSecondsIn()
        // Rotating recreates the rule's activity without its content: a fresh one starts already lying down.
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                activity.setContent {
                    var fullscreen by remember { mutableStateOf(true) }
                    JuntosTheme(dark = true) {
                        Box(Modifier.fillMaxSize().background(Color.Black)) {
                            PlayerSurface(player, Modifier.fillMaxSize())
                            PlayerControls(player, intents, fullscreen, { fullscreen = it })
                        }
                    }
                }
            }
            shoot("controls-landscape")
            rule.mainClock.autoAdvance = false
            rule.onAllNodesWithTag("player-gestures").onLast().performTouchInput { doubleClick(percentOffset(0.85f, 0.5f)) }
            rule.mainClock.advanceTimeBy(250)
            shoot("controls-landscape-skip")
        }
    }
}
