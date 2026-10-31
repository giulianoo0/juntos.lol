package lol.juntos.design

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import kotlinx.coroutines.launch
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class FieldToastTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun aFieldIsFoundByItsLabelAndTakesWhatIsTyped() {
        var typed = ""
        rule.setContent {
            JuntosTheme {
                var value by remember { mutableStateOf("") }
                Field(value = value, onValueChange = { value = it; typed = it }, label = "Nome da sala")
            }
        }
        rule.onNodeWithContentDescription("Nome da sala").performTextInput("Filme")
        assertEquals("Filme", typed)
    }

    @Test
    fun aToastShowsItsMessageAndLeavesOnItsOwn() {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            JuntosTheme {
                val toasts = rememberToastState()
                val scope = rememberCoroutineScope()
                Pill("Copiar", onClick = { scope.launch { toasts.show("Link copiado") } })
                ToastHost(toasts)
            }
        }
        rule.onNodeWithText("Copiar").performClick()
        rule.mainClock.advanceTimeBy(500)
        rule.onNodeWithText("Link copiado").assertExists()
        rule.mainClock.advanceTimeBy(5_000)
        rule.onNodeWithText("Link copiado").assertDoesNotExist()
    }
}
