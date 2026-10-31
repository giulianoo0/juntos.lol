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
import androidx.compose.material.icons.rounded.LockOpen
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.ScreenShare
import androidx.compose.material.icons.rounded.Send
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Videocam
import androidx.compose.material.icons.rounded.VideocamOff
import androidx.compose.ui.graphics.vector.ImageVector

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
    val Fullscreen: ImageVector get() = Icons.Rounded.Fullscreen
    val FullscreenExit: ImageVector get() = Icons.Rounded.FullscreenExit
}
