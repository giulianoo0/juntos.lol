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
    val brand: Color = Color(0xFFFF7640),
    val onBrand: Color = Color(0xFF250F07),
    val primaryFill: Color = Color(0xFF276ED2),
    val onPrimary: Color = Color.White,
    val tile: Color = surface,
    val tile2: Color = surface3,
    val segmentTrack: Color = Color(0x0F000000),
    val segmentChip: Color = surface,
    val dangerInk: Color = danger,
    val dangerSoft: Color = danger.copy(alpha = 0.12f),
    val discord: Color = Color(0xFF5D67EE),
    val hueBg: List<Color> = emptyList(),
    val hueInk: List<Color> = emptyList(),
) {
    /** Over the video: dark glass in both themes, since the picture does not follow the theme. */
    val scrim: Color get() = Color.Black.copy(alpha = 0.45f)
    val scrimStrong: Color get() = Color.Black.copy(alpha = 0.62f)
    val onScrim: Color get() = Color.White
    val field: Color get() = text.copy(alpha = if (isDark) 0.04f else 0.05f)
    val lineStrong: Color get() = (if (isDark) Color.White else Color.Black).copy(alpha = if (isDark) 0.12f else 0.14f)

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
    tile = Color(0xFFFFFFFF),
    tile2 = Color(0xFFE2E2E4),
    segmentTrack = Color(0x0F000000),
    segmentChip = Color(0xFFFFFFFF),
    dangerInk = Color(0xFF9E141E),
    dangerSoft = Color(0x1FDB2730),
    hueBg = hexes("C4E1FF,C3EAC9,F8D8B4,F0D2F7,B8E9EB,FFCFCA,FFCEE0,DDD8FF"),
    hueInk = hexes("1F5596,196632,834B14,7A3E87,006469,9D3533,90355E,5C4A9E"),
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
    onPrimary = Color(0xFF050B18),
    tile = Color(0xFF232322),
    tile2 = Color(0xFF2E2E2D),
    segmentTrack = Color(0x0FFFFFFF),
    segmentChip = Color(0xFF282828),
    dangerInk = Color(0xFFF8A49D),
    dangerSoft = Color(0x38EF4445),
    hueBg = hexes("2D4E78,295935,724720,603E68,04585C,763D39,6F394F,4D4576"),
    hueInk = hexes("A9D4FF,A7E2B2,FFC798,ECBEF6,90E1E6,FFBAB3,FFB9D4,D0C8FF"),
)

private fun hexes(list: String) = list.split(',').map { Color(0xFF000000 or it.toLong(16)) }

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
    val roundButton = 44.dp
}

object JuntosRadii {
    val sm = 6.dp
    val md = 8.dp
    val lg = 10.dp
    val xl = 14.dp
    val xl2 = 18.dp
    val xl3 = 22.dp
    val full = 999.dp
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
