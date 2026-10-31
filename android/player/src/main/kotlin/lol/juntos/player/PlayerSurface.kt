package lol.juntos.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

/** Where the video draws. Onda 2 renders a Media3 player here; any other player draws black. */
@Composable
fun PlayerSurface(player: JuntosPlayer, modifier: Modifier = Modifier) {
    Box(modifier.background(Color.Black))
}
