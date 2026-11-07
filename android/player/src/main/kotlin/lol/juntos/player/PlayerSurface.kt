package lol.juntos.player

import android.view.SurfaceView
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
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
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.material3.Text
import lol.juntos.design.pop
import lol.juntos.design.settle

/** Where the video draws, letterboxed in black, with the subtitles on the picture. Any player but [Media3Player] draws only black. */
@Composable
fun PlayerSurface(player: JuntosPlayer, modifier: Modifier = Modifier, pictureInPicture: Boolean = false) {
    Box(modifier.background(Color.Black).clipToBounds(), contentAlignment = Alignment.Center) {
        if (player is Media3Player) Media3Surface(player, pictureInPicture)
    }
}

@Composable
private fun Media3Surface(player: Media3Player, pictureInPicture: Boolean) {
    val size by player.videoSize.collectAsState()
    val snapshot by player.snapshot.collectAsState()
    val chosen by PictureAspects.current.collectAsState()
    val videoAspect = if (size.width > 0 && size.height > 0) size.width * size.pixelWidthHeightRatio / size.height else 16f / 9f

    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val box = maxWidth.value to maxHeight.value
        val (frameWidth, frameHeight) = if (box.first > 0f && box.second > 0f) pictureFrame(chosen, box.first, box.second, videoAspect) else box
        val width by animateDpAsState(frameWidth.dp, settle(), label = "picture-width")
        val height by animateDpAsState(frameHeight.dp, settle(), label = "picture-height")
        Box(Modifier.requiredSize(width, height).testTag("player-video")) {
            AndroidView(
                factory = { context -> SurfaceView(context).also(player::attach) },
                update = { it.keepScreenOn = snapshot.playing },
                onRelease = player::detach,
                modifier = Modifier.fillMaxSize(),
            )
        }
        // On what shows of the picture: a filled one runs past the box.
        Box(Modifier.size(minOf(width, maxWidth), minOf(height, maxHeight))) {
            Subtitles(player, pictureInPicture)
        }
    }
}

/** As the site's SubtitleLayer: 4.5 % of the picture's height, white over a dark outline, above the controls when they show. */
@Composable
private fun Subtitles(player: Media3Player, pictureInPicture: Boolean) {
    val cues by player.cues.collectAsState()
    val raised by player.controlsShown.collectAsState()
    val lift by animateDpAsState(if (raised) RAISED_LIFT else 12.dp, if (raised) pop() else settle())
    // Sized by the whole picture, as the site does: the lift above the controls must not shrink it.
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val fontSize = with(LocalDensity.current) { subtitleFontSize(maxHeight, pictureInPicture).toSp() }
        Box(
            Modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, bottom = lift),
            contentAlignment = Alignment.BottomCenter,
        ) {
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
}

/** Clears the seek bar, which sits about 73 dp above the picture's bottom with the controls up. */
private val RAISED_LIFT = 96.dp

/** As the site's subtitleFontSize: 4.5 % of the picture, 13 dp at least; a picture-in-picture window is too small for that floor. */
internal fun subtitleFontSize(pictureHeight: Dp, pictureInPicture: Boolean = false): Dp =
    maxOf(if (pictureInPicture) 8.dp else 13.dp, pictureHeight * 0.045f)

/** The outline copy keeps the glyphs' shape (italic, bold) but not their color. */
private fun withoutColors(text: AnnotatedString) = AnnotatedString(
    text.text,
    spanStyles = text.spanStyles.map { AnnotatedString.Range(it.item.copy(color = Color.Unspecified), it.start, it.end) },
)
