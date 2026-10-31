package lol.juntos.app

import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import lol.juntos.core.fake.FakeSyncSessionFactory
import lol.juntos.core.model.Member
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Not a check: the screens for review, saved where `adb pull` finds them. Runs only with
 * `-Pandroid.testInstrumentationRunnerArguments.prints=<suffix>`, e.g. `light` or `dark`.
 */
class Prints {
    @get:Rule
    val rule = createEmptyComposeRule()

    private val args = InstrumentationRegistry.getArguments()
    private val suffix: String? = args.getString("prints")
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val dir = File(instrumentation.targetContext.getExternalFilesDir(null), "prints").apply { mkdirs() }

    private fun shot(name: String) {
        rule.waitForIdle()
        Thread.sleep(900)
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(dir, "$name-$suffix.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun back() {
        instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
        Thread.sleep(900)
        rule.waitForIdle()
    }

    @Test
    fun room() {
        assumeTrue(suffix != null)
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("juntos://room/ABCD1234")).setClassName(instrumentation.targetContext, MainActivity::class.java.name)
        val scenario = ActivityScenario.launch<MainActivity>(intent)
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Sala de teste")).fetchSemanticsNodes().isNotEmpty() }
        var graph: AppGraph? = null
        scenario.onActivity { graph = (it.application as JuntosApplication).graph }
        val session = (graph!!.sessions as FakeSyncSessionFactory).opened.last()
        session.join(Member("ana", "Ana", avatar = "fox.bowtie", mic = true))
        session.join(Member("bia", "Bia", avatar = "penguin", cam = true))
        session.join(Member("caio", "Caio", avatar = "robot.headphones"))
        session.say("Ana", "bora começar?")
        session.say("Caio", "pipoca pronta 🍿")
        shot("room-portrait")
        rule.onNodeWithText("Caio").assertExists()
        rule.onNodeWithContentDescription("Chat").performClick()
        shot("chat-portrait")
        back()
        rule.onNodeWithContentDescription("Pessoas").performClick()
        shot("people-portrait")
        back()
        rule.onNodeWithContentDescription("Configurações").performClick()
        shot("settings-audio-portrait")
        rule.onNodeWithText("Legendas").performClick()
        shot("settings-subtitles-portrait")
        back()
        rule.onNodeWithContentDescription("Reações").performClick()
        shot("reactions-portrait")
        back()
        rule.onAllNodes(androidx.compose.ui.test.hasContentDescription("Fixar"))[2].performClick()
        shot("room-pinned-portrait")
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        Thread.sleep(1500)
        shot("room-landscape")
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        Thread.sleep(800)
        scenario.close()
    }

    @Test
    fun home() {
        assumeTrue(suffix != null)
        val scenario = ActivityScenario.launch(MainActivity::class.java)
        Thread.sleep(1500)
        shot("home-portrait")
        rule.onNodeWithText("Criar sala").performClick()
        shot("popover-portrait")
        back()
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
        Thread.sleep(1500)
        shot("home-landscape")
        scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
        scenario.close()
    }
}
