package lol.juntos.design

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp

enum class PillTone { Brand, Primary, Soft, Danger, Glass }

enum class PillSize(val height: Dp, val padding: Dp, val text: TextUnit, val weight: FontWeight) {
    Sm(32.dp, 12.dp, JuntosTextSize.xs, FontWeight.Medium),
    Md(36.dp, 16.dp, JuntosTextSize.sm, FontWeight.Medium),
    Lg(44.dp, 20.dp, JuntosTextSize.base, FontWeight.SemiBold),
}

internal data class Ink(val fill: Color, val ink: Color)

@Composable
internal fun inkOf(tone: PillTone): Ink {
    val c = Juntos.colors
    return when (tone) {
        PillTone.Brand -> Ink(c.brand, c.onBrand)
        PillTone.Primary -> Ink(c.primaryFill, Color.White)
        PillTone.Soft -> Ink(c.buttonSecondary, c.text)
        PillTone.Danger -> Ink(c.danger, Color.White)
        PillTone.Glass -> Ink(c.scrim, c.onScrim)
    }
}

/** --press-scale: one short give for every button, the same curve as the site's press. */
@Composable
fun Modifier.pressScale(interaction: MutableInteractionSource, scale: Float = 0.97f): Modifier {
    val pressed by interaction.collectIsPressedAsState()
    val motion = LocalMotionEnabled.current
    val s by animateFloatAsState(
        if (pressed && motion) scale else 1f,
        tween(JuntosMotion.PRESS_MS, easing = JuntosMotion.EaseOut),
        label = "press",
    )
    return graphicsLayer { scaleX = s; scaleY = s }
}

@Composable
fun Pill(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tone: PillTone = PillTone.Soft,
    size: PillSize = PillSize.Md,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    loading: Boolean = false,
) {
    val interaction = remember { MutableInteractionSource() }
    val ink = inkOf(tone)
    Row(
        modifier
            .pressScale(interaction)
            .alpha(if (enabled || loading) 1f else 0.5f)
            .height(size.height)
            .clip(CircleShape)
            .background(ink.fill)
            .clickable(interaction, indication = null, enabled = enabled && !loading, role = Role.Button, onClick = onClick)
            .padding(horizontal = size.padding),
        horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(16.dp), color = ink.ink, strokeWidth = 2.dp)
        } else if (icon != null) {
            Icon(icon, contentDescription = null, tint = ink.ink, modifier = Modifier.size(if (size == PillSize.Sm) 14.dp else 16.dp))
        }
        Text(text, color = ink.ink, fontSize = size.text, fontWeight = size.weight, maxLines = 1)
    }
}

/**
 * The round button of the dock: the label is its name for screen readers, never
 * written under it. `off` paints it red, the way the site shows a muted mic.
 */
@Composable
fun IconPill(
    label: String,
    icon: ImageVector,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    off: Boolean = false,
    tone: PillTone = PillTone.Soft,
    size: Dp = JuntosSpacing.roundButton,
    enabled: Boolean = true,
) {
    val interaction = remember { MutableInteractionSource() }
    val c = Juntos.colors
    val ink = inkOf(if (off) PillTone.Danger else tone)
    val fill = if (active && !off && tone == PillTone.Soft) c.hoverStrong else ink.fill
    Box(
        modifier
            .pressScale(interaction, 0.94f)
            .alpha(if (enabled) 1f else 0.5f)
            .size(size)
            .clip(CircleShape)
            .background(fill)
            .clickable(interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics {
                contentDescription = label
                if (active) selected = true
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = ink.ink, modifier = Modifier.size(size * 0.41f))
    }
}
