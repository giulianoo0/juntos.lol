package lol.juntos.design

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.rounded.Fullscreen
import androidx.compose.material.icons.rounded.FullscreenExit
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.ScreenShare
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.outlined.SmartDisplay
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** The site's lucide icons, by the Material Rounded glyph closest to each. */
object JuntosIcons {
    val Plus: ImageVector get() = Icons.Rounded.Add
    val Lock: ImageVector get() = Icons.Outlined.Lock
    val Unlock: ImageVector get() = Icons.Rounded.LockOpen
    val Mic: ImageVector get() = Icons.Rounded.Mic
    val MicOff: ImageVector get() = Icons.Rounded.MicOff
    val Cam: ImageVector get() = Icons.Outlined.Videocam
    val CamOff: ImageVector get() = Icons.Rounded.VideocamOff
    val Share: ImageVector get() = Icons.Outlined.ScreenShare
    val Smile: ImageVector get() = Icons.Outlined.EmojiEmotions
    val Chat: ImageVector get() = Icons.AutoMirrored.Outlined.Chat
    val People: ImageVector get() = Icons.Outlined.Group
    val Settings: ImageVector get() = Icons.Outlined.Settings
    val Leave: ImageVector get() = Icons.AutoMirrored.Outlined.Logout
    val Pin: ImageVector get() = Icons.Outlined.PushPin
    val Link: ImageVector get() = Icons.Rounded.Link
    val Close: ImageVector get() = Icons.Rounded.Close
    val Check: ImageVector get() = Icons.Rounded.Check
    val Send: ImageVector get() = Icons.Rounded.Send
    val Film: ImageVector get() = Icons.Outlined.Movie
    val Fullscreen: ImageVector get() = Icons.Rounded.Fullscreen
    val FullscreenExit: ImageVector get() = Icons.Rounded.FullscreenExit
    val Back: ImageVector get() = Icons.AutoMirrored.Rounded.ArrowBack
    val Youtube: ImageVector get() = Icons.Outlined.SmartDisplay
    val Magnet: ImageVector by lazy { lucide("Magnet", "m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15", "m5 8 4 4", "m12 15 4 4") }
}

/** A lucide glyph from its 24-unit stroke paths; Icon tints it like the Material ones. */
private fun lucide(name: String, vararg paths: String): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        paths.forEach { d ->
            addPath(
                pathData = addPathNodes(d),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()
