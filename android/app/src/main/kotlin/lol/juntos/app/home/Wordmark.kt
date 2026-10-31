package lol.juntos.app.home

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics

// web/src/pages/home/Wordmark.tsx: one stroke per letter, the play arrow is the ".".
private val STROKES = listOf(
    "M 12 -42 L 12 0 A 12 12 0 0 1 0 12",
    "M 34 -42 L 34 -18 A 18 18 0 0 0 70 -18",
    "M 70 -42 L 70 -6",
    "M 92 -42 L 92 -6",
    "M 92 -24 A 18 18 0 0 1 128 -24 L 128 -6",
    "M 161 -62 L 161 -6",
    "M 150 -42 L 172 -42",
    "M 213 -43.5 A 19 19.5 0 1 1 212.98 -43.5",
    "M 277.93 -37.1 A 12 10.5 0 1 0 266 -25.5 A 12 10.5 0 1 1 254.88 -11.07",
    "M 336 -68 L 336 -6",
    "M 377 -43.5 A 19 19.5 0 1 1 376.98 -43.5",
    "M 418 -68 L 418 -6",
)
private const val ARROW = "M 299 -33 L 313 -24 L 299 -15 Z"
private const val VIEW_X = -8f
private const val VIEW_Y = -80f
private const val VIEW_W = 440f
private const val VIEW_H = 108f

@Composable
fun Wordmark(ink: Color, arrow: Color, modifier: Modifier = Modifier) {
    val letters = remember { STROKES.map { PathParser().parsePathString(it).toPath() } }
    val play = remember { PathParser().parsePathString(ARROW).toPath() }
    Canvas(modifier.aspectRatio(VIEW_W / VIEW_H).semantics { contentDescription = "juntos.lol" }) {
        val k = size.width / VIEW_W
        withTransform({ scale(k, k, Offset.Zero) }) {
            translate(-VIEW_X, -VIEW_Y) {
                val stroke = Stroke(width = 12f, cap = StrokeCap.Round, join = StrokeJoin.Round)
                letters.forEach { drawPath(it, ink, style = stroke) }
                drawCircle(ink, radius = 6.5f, center = Offset(12f, -58f))
                drawPath(play, arrow)
            }
        }
    }
}
