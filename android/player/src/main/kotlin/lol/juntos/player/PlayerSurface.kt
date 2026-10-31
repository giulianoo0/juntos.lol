package lol.juntos.player

import android.view.SurfaceView
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView

/** Where the video draws, letterboxed in black. Any player but [Media3Player] draws only black. */
@Composable
fun PlayerSurface(player: JuntosPlayer, modifier: Modifier = Modifier) {
    Box(modifier.background(Color.Black), contentAlignment = Alignment.Center) {
        if (player is Media3Player) Media3Surface(player)
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun Media3Surface(player: Media3Player) {
    val size by player.videoSize.collectAsState()
    val snapshot by player.snapshot.collectAsState()
    val cues by player.cues.collectAsState()
    val aspect = if (size.width > 0 && size.height > 0) size.width * size.pixelWidthHeightRatio / size.height else 16f / 9f

    Box(Modifier.aspectRatio(aspect).testTag("player-video")) {
        AndroidView(
            factory = { context -> SurfaceView(context).also(player::attach) },
            update = { it.keepScreenOn = snapshot.playing },
            onRelease = player::detach,
            modifier = Modifier.fillMaxSize(),
        )
        AndroidView(
            factory = { context -> SubtitleView(context) },
            update = { it.setCues(cues) },
            modifier = Modifier.fillMaxSize(),
        )
    }
}
