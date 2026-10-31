package lol.juntos.design

import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.espresso.Espresso
import org.junit.Rule
import org.junit.Test

class ComponentsTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun choosingASegmentSelectsItAndLeavesTheOthers() {
        rule.setContent {
            JuntosTheme {
                var picked by remember { mutableStateOf("Áudio") }
                Segmented(options = listOf("Áudio", "Legendas"), selected = picked, onSelect = { picked = it }, label = { it })
            }
        }
        rule.onNodeWithText("Áudio").assertIsSelected()
        rule.onNodeWithText("Legendas").performClick()
        rule.onNodeWithText("Legendas").assertIsSelected()
        rule.onNodeWithText("Áudio").assertIsNotSelected()
    }

    @Test
    fun thePopoverOpensFromItsTriggerAndClosesOnBack() {
        rule.setContent {
            JuntosTheme {
                SpringPopover(trigger = { open -> Pill("Criar sala", onClick = open) }) { Text("Nome da sala") }
            }
        }
        rule.onNodeWithText("Nome da sala").assertDoesNotExist()
        rule.onNodeWithText("Criar sala").performClick()
        rule.onNodeWithText("Nome da sala").assertExists()
        Espresso.pressBack()
        rule.waitForIdle()
        rule.onNodeWithText("Nome da sala").assertDoesNotExist()
    }

    @Test
    fun anIconPillIsNamedByItsLabel() {
        var taps = 0
        rule.setContent {
            JuntosTheme { IconPill(label = "Senha", icon = JuntosIcons.Lock, onClick = { taps++ }) }
        }
        rule.onNodeWithContentDescription("Senha").performClick()
        assert(taps == 1)
    }
}
