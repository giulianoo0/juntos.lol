package lol.juntos.design

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.rememberTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** A pill-shaped input: the label names it for screen readers; the placeholder only repeats it. */
@Composable
fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = label,
    password: Boolean = false,
    mono: Boolean = false,
    imeAction: ImeAction = ImeAction.Done,
    onSubmit: () -> Unit = {},
    trailing: (@Composable BoxScope.() -> Unit)? = null,
) {
    val c = Juntos.colors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val line = if (focused) c.primary.copy(alpha = 0.45f) else c.line.copy(alpha = 0f)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        interactionSource = interaction,
        textStyle = TextStyle(
            color = c.text,
            fontSize = JuntosTextSize.lg,
            fontWeight = FontWeight.Medium,
            fontFamily = if (mono && value.isNotEmpty()) JuntosFonts.mono else JuntosFonts.sans,
        ),
        cursorBrush = SolidColor(c.primary),
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            keyboardType = if (password) KeyboardType.Password else KeyboardType.Text,
            imeAction = imeAction,
        ),
        keyboardActions = KeyboardActions(onAny = { onSubmit() }),
        modifier = modifier
            .height(JuntosSpacing.touchTarget)
            .semantics { contentDescription = label },
        decorationBox = { inner ->
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(c.field, CircleShape)
                    .border(1.dp, line, CircleShape)
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (value.isEmpty()) Text(placeholder, color = c.textMuted, fontSize = JuntosTextSize.lg)
                inner()
                if (trailing != null) Box(Modifier.align(Alignment.CenterEnd)) { trailing() }
            }
        },
    )
}

@Stable
class ToastState {
    var message by mutableStateOf<String?>(null)
        private set

    suspend fun show(text: String, millis: Long = 2_600) {
        message = text
        delay(millis)
        if (message == text) message = null
    }
}

@Composable
fun rememberToastState() = remember { ToastState() }

/** The toast pops up from the bottom on the glass and settles away on its own. */
@Composable
fun ToastHost(state: ToastState, modifier: Modifier = Modifier) {
    val visible = remember { MutableTransitionState(false) }
    var last by remember { mutableStateOf("") }
    state.message?.let { last = it }
    visible.targetState = state.message != null
    if (!visible.currentState && !visible.targetState) return
    val popSpec = pop<Float>()
    val settleSpec = settle<Float>()
    val motion = LocalMotionEnabled.current
    val t = rememberTransition(visible, label = "toast")
    val p by t.animateFloat({ if (targetState) popSpec else settleSpec }, label = "toast-p") { if (it) 1f else 0f }
    val c = Juntos.colors
    Box(modifier.fillMaxWidth().padding(bottom = 24.dp), contentAlignment = Alignment.BottomCenter) {
        AnimatedContent(last, label = "toast-text") { text ->
            Text(
                text,
                color = c.text,
                fontSize = JuntosTextSize.sm,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .graphicsLayer {
                        scaleX = p; scaleY = p
                        transformOrigin = TransformOrigin(0.5f, 1f)
                        alpha = if (motion) 1f else p
                    }
                    .blur(if (motion) (8f * (1f - p).coerceIn(0f, 1f)).dp else 0.dp)
                    .shadow(16.dp, CircleShape)
                    .background(c.overlay, CircleShape)
                    .padding(horizontal = 16.dp, vertical = 10.dp),
            )
        }
    }
}
