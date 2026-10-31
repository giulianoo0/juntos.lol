package lol.juntos.player

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/** What the controls ask for; the room decides whether it goes to the socket. */
interface PlayerIntents {
    fun play(positionMs: Long)
    fun pause(positionMs: Long)
    fun seek(positionMs: Long)
}

/**
 * The phone's controls over the video: a tap shows and hides them, a double tap on
 * either side skips 10 s, the bar scrubs with a time preview. Onda 2 fills it in.
 */
@Composable
fun PlayerControls(
    player: JuntosPlayer,
    intents: PlayerIntents,
    fullscreen: Boolean,
    onFullscreenChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
}
