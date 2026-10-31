package lol.juntos.player

import android.view.SurfaceView
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.material3.Text
import lol.juntos.design.pop
import lol.juntos.design.settle

/** Where the video draws, letterboxed in black, with the subtitles on the picture. Any player but [Media3Player] draws only black. */
@Composable
fun PlayerSurface(player: JuntosPlayer, modifier: Modifier = Modifier) {
    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        if (player is Media3Player) Media3Surface(player)
    }
}

@Composable
private fun Media3Surface(player: Media3Player) {
    val size by player.videoSize.collectAsState()
    val snapshot by player.snapshot.collectAsState()
    val aspect = if (size.width > 0 && size.height > 0) size.width * size.pixelWidthHeightRatio / size.height else 16f / 9f

    Box(Modifier.aspectRatio(aspect).testTag("player-video")) {
        AndroidView(
            factory = { context -> SurfaceView(context).also(player::attach) },
            update = { it.keepScreenOn = snapshot.playing },
            onRelease = player::detach,
            modifier = Modifier.fillMaxSize(),
        )
        Subtitles(player)
    }
}

/** As the site's SubtitleLayer: 4.5 % of the picture's height, white over a dark outline, above the controls when they show. */
@Composable
private fun Subtitles(player: Media3Player) {
    val cues by player.cues.collectAsState()
    val raised by player.controlsShown.collectAsState()
    val lift by animateDpAsState(if (raised) 72.dp else 12.dp, if (raised) pop() else settle())
    BoxWithConstraints(
        Modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, bottom = lift),
        contentAlignment = Alignment.BottomCenter,
    ) {
        val fontSize = with(LocalDensity.current) { maxOf(13.dp.toPx(), maxHeight.toPx() * 0.045f).toSp() }
        val stroke = with(LocalDensity.current) { fontSize.toPx() * 0.16f }
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Bottom) {
            for (cue in cues) {
                val base = TextStyle(fontSize = fontSize, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center, lineHeight = fontSize * 1.2f)
                Box(Modifier.testTag("player-subtitle"), contentAlignment = Alignment.Center) {
                    Text(
                        withoutColors(cue.text),
                        style = base.copy(color = Color.Black.copy(alpha = 0.85f), drawStyle = Stroke(stroke, join = StrokeJoin.Round)),
                    )
                    Text(
                        cue.text,
                        style = base.copy(color = Color.White, shadow = Shadow(Color.Black.copy(alpha = 0.6f), Offset(0f, 1f), 4f)),
                    )
                }
            }
        }
    }
}

/** The outline copy keeps the glyphs' shape (italic, bold) but not their color. */
private fun withoutColors(text: AnnotatedString) = AnnotatedString(
    text.text,
    spanStyles = text.spanStyles.map { AnnotatedString.Range(it.item.copy(color = Color.Unspecified), it.start, it.end) },
)
