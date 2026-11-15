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
    val RotateCw: ImageVector by lazy { lucide("RotateCw", "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8", "M21 3v5h-5") }
    val Maximize: ImageVector by lazy { lucide("Maximize", "M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3") }
    val Minimize: ImageVector by lazy { lucide("Minimize", "M8 3v3a2 2 0 0 1-2 2H3", "M21 8h-3a2 2 0 0 1-2-2V3", "M3 16h3a2 2 0 0 1 2 2v3", "M16 21v-3a2 2 0 0 1 2-2h3") }
    val Puzzle: ImageVector by lazy { lucide("Puzzle", "M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z") }
    val Magnet: ImageVector by lazy { lucide("Magnet", "m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15", "m5 8 4 4", "m12 15 4 4") }
}

/** Discord's mark, filled, on a 24×18 box like the site's DiscordGlyph. */
val DiscordMark: ImageVector by lazy {
    ImageVector.Builder("Discord", 24.dp, 18.dp, 24f, 18f).apply {
        addPath(
            pathData = addPathNodes("M20.3 1.5A19.6 19.6 0 0 0 15.4 0l-.6 1.3a18 18 0 0 0-5.6 0L8.6 0a19.6 19.6 0 0 0-4.9 1.5C.6 6.2-.3 10.7.1 15.2a19.8 19.8 0 0 0 6 3l1.3-2a12.7 12.7 0 0 1-2-1l.5-.4a14 14 0 0 0 12.1 0l.5.4c-.6.4-1.3.7-2 1l1.3 2a19.7 19.7 0 0 0 6-3c.5-5.2-.8-9.7-3.5-13.7ZM8 12.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 7.6 8 7.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"),
            fill = SolidColor(Color.Black),
        )
    }.build()
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
