package lol.juntos.design

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.BlurEffect
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * The one question before something runs, as lawcore asks it: a badge, the question, and two
 * equal pills. "Cancelar" comes first. The card springs from the middle like every popover here
 * and settles back before the answer goes out.
 */
@Composable
fun ConfirmDialog(
    title: String,
    confirm: String,
    icon: ImageVector,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    cancel: String = "Cancelar",
) {
    val c = Juntos.colors
    val progress = remember { Animatable(0f) }
    var answer by remember { mutableStateOf<(() -> Unit)?>(null) }
    val enter = pop<Float>()
    val exit = settle<Float>()
    LaunchedEffect(Unit) { progress.animateTo(1f, enter) }
    LaunchedEffect(answer) {
        val then = answer ?: return@LaunchedEffect
        progress.animateTo(0f, exit)
        then()
    }
    val blur = with(LocalDensity.current) { 8.dp.toPx() }
    val leave = { done: () -> Unit -> if (answer == null) answer = done }

    Dialog(onDismissRequest = { leave(onCancel) }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier
                .fillMaxSize()
                .clickable(remember { MutableInteractionSource() }, indication = null) { leave(onCancel) },
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier
                    .padding(horizontal = 24.dp)
                    .widthIn(max = 384.dp)
                    .fillMaxWidth()
                    .graphicsLayer {
                        val p = progress.value
                        scaleX = p
                        scaleY = p
                        alpha = p.coerceIn(0f, 1f)
                        transformOrigin = TransformOrigin.Center
                        val r = (1f - p).coerceIn(0f, 1f) * blur
                        renderEffect = if (r > 0.5f) BlurEffect(r, r) else null
                    }
                    .clip(RoundedCornerShape(JuntosRadii.xl3))
                    .background(c.overlay)
                    .clickable(remember { MutableInteractionSource() }, indication = null) {}
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Box(
                    Modifier.padding(bottom = 4.dp).size(64.dp).clip(RoundedCornerShape(JuntosRadii.xl2)).background(c.brand),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(icon, contentDescription = null, tint = c.onBrand, modifier = Modifier.size(26.dp))
                }
                Text(title, color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
                Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Pill(cancel, onClick = { leave(onCancel) }, size = PillSize.Lg, modifier = Modifier.weight(1f))
                    Pill(confirm, onClick = { leave(onConfirm) }, tone = PillTone.Brand, size = PillSize.Lg, modifier = Modifier.weight(1f))
                }
            }
        }
    }
}
