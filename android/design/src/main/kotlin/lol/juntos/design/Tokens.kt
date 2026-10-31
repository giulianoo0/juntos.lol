package lol.juntos.design

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// web/src/styles/tokens.css, with oklch converted to sRGB and rem at 16 px.

@Immutable
data class JuntosColors(
    val frameGround: Color,
    val surface: Color,
    val surface2: Color,
    val surface3: Color,
    val overlay: Color,
    val text: Color,
    val textMuted: Color,
    val textFaint: Color,
    val line: Color,
    val primary: Color,
    val danger: Color,
    val success: Color,
    val popoverGlass: Color,
    val isDark: Boolean,
) {
    val hover: Color get() = text.copy(alpha = if (isDark) 0.07f else 0.05f)
    val hoverStrong: Color get() = text.copy(alpha = if (isDark) 0.12f else 0.10f)
    val buttonSecondary: Color get() = hover
}

val LightColors = JuntosColors(
    frameGround = Color(0xFFEDEDEE),
    surface = Color(0xFFFFFFFF),
    surface2 = Color(0xFFECECED),
    surface3 = Color(0xFFE2E2E4),
    overlay = Color(0xFFFFFFFF),
    text = Color(0xFF111111),
    textMuted = Color(0xFF5F5F63),
    textFaint = Color(0xFF8E8E93),
    line = Color(0x14000000),
    primary = Color(0xFF276ED2),
    danger = Color(0xFFDB2730),
    success = Color(0xFF53BE70),
    popoverGlass = Color(0xB8FFFFFF),
    isDark = false,
)

val DarkColors = JuntosColors(
    frameGround = Color(0xFF0F0F0F),
    surface = Color(0xFF1F1F1F),
    surface2 = Color(0xFF282828),
    surface3 = Color(0xFF3D3F40),
    overlay = Color(0xFF282828),
    text = Color(0xFFEDEDED),
    textMuted = Color(0xFF9B9B9B),
    textFaint = Color(0xFF6E6E6E),
    line = Color(0x12FFFFFF),
    primary = Color(0xFF5494EC),
    danger = Color(0xFFEF4445),
    success = Color(0xFF53BE70),
    popoverGlass = Color(0xB8282828),
    isDark = true,
)

object JuntosSpacing {
    val s1 = 4.dp
    val s2 = 6.dp
    val s3 = 8.dp
    val s4 = 12.dp
    val s5 = 16.dp
    val s6 = 20.dp
    val s8 = 24.dp
    val s10 = 32.dp
    val s12 = 40.dp
    val s16 = 52.dp
    val controlHeight = 36.dp
    val touchTarget = 44.dp
}

object JuntosRadii {
    val sm = 6.dp
    val md = 8.dp
    val lg = 10.dp
    val xl = 14.dp
    val xl2 = 18.dp
    val xl3 = 22.dp
}

object JuntosTextSize {
    val xs2 = 11.sp
    val xs = 12.5.sp
    val sm = 13.5.sp
    val base = 14.sp
    val lg = 16.sp
    val xl = 20.sp
    val xl2 = 25.sp
}
