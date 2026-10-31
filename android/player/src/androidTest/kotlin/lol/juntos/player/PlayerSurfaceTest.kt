package lol.juntos.player

import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

class PlayerSurfaceTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val player = newPlayer()

    @After
    fun release() = onMain { player.release() }

    private fun showPlaying() {
        rule.setContent { PlayerSurface(player, Modifier.size(320.dp)) }
        onMain {
            player.load(MediaSource("$clipsBase/rich/master.m3u8"))
            player.play()
        }
        player.awaitPlaying()
        rule.waitForIdle()
    }

    private fun surface(): SurfaceView {
        fun find(view: View): SurfaceView? = view as? SurfaceView
            ?: (view as? ViewGroup)?.let { group -> (0 until group.childCount).firstNotNullOfOrNull { find(group.getChildAt(it)) } }
        return find(rule.activity.window.decorView)!!
    }

    @Test
    fun theScreenStaysOnWhilePlayingAndNotWhenPaused() {
        showPlaying()
        rule.waitUntil(5_000) { surface().keepScreenOn }
        onMain { player.pause() }
        rule.waitUntil(5_000) { !surface().keepScreenOn }
        assertFalse(surface().keepScreenOn)
    }

    @Test
    fun theVideoKeepsItsAspectInsideTheBox() {
        showPlaying()
        rule.waitUntil(5_000) { player.videoSize.value.width > 0 }
        rule.waitForIdle()
        rule.onNodeWithTag("player-video").assertWidthIsEqualTo(320.dp).assertHeightIsEqualTo(180.dp)
        assertTrue(surface().holder.surface.isValid)
    }
}
