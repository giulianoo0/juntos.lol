package lol.juntos.design

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em

// Geist for the interface, Bricolage Grotesque for the landing's titles, Geist Mono for codes (all OFL).
object JuntosFonts {
    val sans = FontFamily(
        Font(R.font.geist_regular, FontWeight.Normal),
        Font(R.font.geist_medium, FontWeight.Medium),
        Font(R.font.geist_semibold, FontWeight.SemiBold),
    )
    val display = FontFamily(
        Font(R.font.bricolage_bold, FontWeight.Bold),
        Font(R.font.bricolage_extrabold, FontWeight.ExtraBold),
    )
    val mono = FontFamily(Font(R.font.geist_mono_medium, FontWeight.Medium))
}

object JuntosType {
    val body = TextStyle(fontFamily = JuntosFonts.sans, fontSize = JuntosTextSize.base, letterSpacing = (-0.005).em)
    val label = body.copy(fontSize = JuntosTextSize.sm, fontWeight = FontWeight.Medium)
    val title = body.copy(fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.015).em)
    val display = TextStyle(fontFamily = JuntosFonts.display, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.045).em, lineHeight = 0.98.em)
}

internal val JuntosTypography = Typography().run {
    copy(
        displayLarge = displayLarge.copy(fontFamily = JuntosFonts.display),
        displayMedium = displayMedium.copy(fontFamily = JuntosFonts.display),
        headlineLarge = headlineLarge.copy(fontFamily = JuntosFonts.display),
        headlineMedium = headlineMedium.copy(fontFamily = JuntosFonts.sans),
        headlineSmall = headlineSmall.copy(fontFamily = JuntosFonts.sans),
        titleLarge = titleLarge.copy(fontFamily = JuntosFonts.sans),
        titleMedium = titleMedium.copy(fontFamily = JuntosFonts.sans),
        titleSmall = titleSmall.copy(fontFamily = JuntosFonts.sans),
        bodyLarge = JuntosType.body.copy(fontSize = JuntosTextSize.lg),
        bodyMedium = JuntosType.body,
        bodySmall = JuntosType.body.copy(fontSize = JuntosTextSize.xs),
        labelLarge = JuntosType.label,
        labelMedium = JuntosType.label.copy(fontSize = JuntosTextSize.xs),
        labelSmall = JuntosType.label.copy(fontSize = JuntosTextSize.xs2),
    )
}
