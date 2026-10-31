package lol.juntos.app.room

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import lol.juntos.app.BuildConfig
import lol.juntos.design.IconPill
import lol.juntos.design.JuntosIcons
import lol.juntos.design.Pill
import lol.juntos.design.PillSize
import lol.juntos.design.PillTone
import lol.juntos.design.SpringPopover
import lol.juntos.design.SpringRow

private val REACTIONS = listOf("😂", "❤️", "👏", "😮", "🔥", "🎉")

@Composable
fun Dock(
    sheet: Sheet?,
    onSheet: (Sheet) -> Unit,
    canShare: Boolean,
    onReact: (String) -> Unit,
    onLeave: () -> Unit,
) {
    Row(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (canShare) Pill("Compartilhar", onClick = { onSheet(Sheet.Share) }, tone = PillTone.Primary, size = PillSize.Lg, icon = JuntosIcons.Share)
        SpringPopover(
            width = 300.dp,
            trigger = { open -> IconPill("Reações", JuntosIcons.Smile, onClick = open) },
        ) { close ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                REACTIONS.forEach { emoji ->
                    Box(
                        Modifier
                            .size(44.dp)
                            .clip(RoundedCornerShape(12.dp))
                            .clickable(role = Role.Button) { close(); onReact(emoji) },
                        contentAlignment = Alignment.Center,
                    ) { Text(emoji, fontSize = 26.sp) }
                }
            }
        }
        IconPill("Chat", JuntosIcons.Chat, onClick = { onSheet(Sheet.Chat) }, active = sheet == Sheet.Chat)
        Spacer(Modifier.weight(1f))
        SpringPopover(trigger = { open -> IconPill("Sair", JuntosIcons.Leave, onClick = open, tone = PillTone.Danger) }) { close ->
            SpringRow("Sair da sala", icon = JuntosIcons.Leave, danger = true, onClick = { close(); onLeave() })
            SpringRow("Cancelar", icon = JuntosIcons.Close, onClick = close)
        }
    }
}

/** The room's link, to copy or hand to another app. */
@Composable
internal fun Invite(roomId: String, onCopied: () -> Unit) {
    val context = LocalContext.current
    val link = "${BuildConfig.BASE_URL}/room/$roomId"
    SpringPopover(trigger = { open -> IconPill("Convidar", JuntosIcons.Link, onClick = open, size = 36.dp) }) { close ->
        SpringRow("Copiar link da sala", icon = JuntosIcons.Link, onClick = {
            close()
            context.copy(link)
            onCopied()
        })
        SpringRow("Enviar o link", icon = JuntosIcons.Send, onClick = {
            close()
            val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
            context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        })
    }
}

private fun Context.copy(text: String) {
    (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("juntos", text))
}
