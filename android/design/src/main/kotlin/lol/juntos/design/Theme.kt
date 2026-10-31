package lol.juntos.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

val LocalJuntosColors = staticCompositionLocalOf { LightColors }

object Juntos {
    val colors: JuntosColors
        @Composable @ReadOnlyComposable get() = LocalJuntosColors.current
}

@Composable
fun JuntosTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val colors = if (dark) DarkColors else LightColors
    val scheme = if (dark) {
        darkColorScheme(primary = colors.primary, background = colors.frameGround, surface = colors.surface, onBackground = colors.text, onSurface = colors.text, error = colors.danger)
    } else {
        lightColorScheme(primary = colors.primary, background = colors.frameGround, surface = colors.surface, onBackground = colors.text, onSurface = colors.text, error = colors.danger)
    }
    CompositionLocalProvider(LocalJuntosColors provides colors, LocalMotionEnabled provides systemMotionEnabled()) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}

/** The "beta" seal the APK build carries while it ships outside the store. */
@Composable
fun BetaBadge(modifier: Modifier = Modifier) {
    Text(
        text = "beta",
        color = Juntos.colors.primary,
        fontWeight = FontWeight.SemiBold,
        fontSize = JuntosTextSize.xs2,
        modifier = modifier
            .clip(RoundedCornerShape(999.dp))
            .background(Juntos.colors.primary.copy(alpha = 0.14f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    )
}
