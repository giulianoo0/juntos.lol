package lol.juntos.player

import android.app.PendingIntent
import android.content.Context
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player
import androidx.media3.session.MediaSession

/**
 * The room's player as the system sees it: the lock screen, the media controls, a headset's
 * button. Play, pause and seek from there go to the room like the on-screen controls do.
 */
class RoomMediaSession(context: Context, private val player: Media3Player, private val intents: PlayerIntents, open: PendingIntent) {
    private val forwarding = object : ForwardingPlayer(player.exo) {
        override fun play() = intents.play(player.positionMs)
        override fun pause() = intents.pause(player.positionMs)
        override fun setPlayWhenReady(playWhenReady: Boolean) = if (playWhenReady) play() else pause()
        override fun seekTo(positionMs: Long) = intents.seek(player.roomTime(positionMs))
        override fun seekTo(mediaItemIndex: Int, positionMs: Long) = intents.seek(player.roomTime(positionMs))
        override fun seekForward() = intents.seek(player.positionMs + seekForwardIncrement)
        override fun seekBack() = intents.seek((player.positionMs - seekBackIncrement).coerceAtLeast(0))

        override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon()
            .removeAll(
                Player.COMMAND_SEEK_TO_NEXT,
                Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                Player.COMMAND_SEEK_TO_PREVIOUS,
                Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                Player.COMMAND_STOP,
            )
            .build()

        override fun isCommandAvailable(command: Int): Boolean = availableCommands.contains(command)
    }

    val session: MediaSession = MediaSession.Builder(context, forwarding).setId("juntos-room").setSessionActivity(open).build()

    fun release() = session.release()
}
