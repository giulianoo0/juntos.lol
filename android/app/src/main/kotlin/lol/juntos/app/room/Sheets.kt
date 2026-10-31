package lol.juntos.app.room

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import lol.juntos.core.model.ChatMessage
import lol.juntos.core.model.Member
import lol.juntos.design.Avatar
import lol.juntos.design.Field
import lol.juntos.design.IconPill
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosMotion
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.PillTone
import lol.juntos.design.Segmented
import lol.juntos.design.SpringRow
import lol.juntos.design.hueOf
import lol.juntos.player.JuntosPlayer
import androidx.compose.animation.core.tween

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun JuntosSheet(onDismiss: () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val c = Juntos.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.surface,
        contentColor = c.text,
        scrimColor = androidx.compose.ui.graphics.Color.Black.copy(alpha = if (c.isDark) 0.55f else 0.4f),
        shape = RoundedCornerShape(topStart = 22.dp, topEnd = 22.dp),
        dragHandle = {
            Box(Modifier.padding(top = 10.dp, bottom = 6.dp).size(width = 36.dp, height = 4.dp).background(c.line, CircleShape))
        },
    ) {
        Column(Modifier.navigationBarsPadding().padding(horizontal = 16.dp).padding(bottom = 12.dp), content = content)
    }
}

@Composable
private fun SheetTitle(text: String) {
    Text(text, color = Juntos.colors.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 8.dp))
}

@Composable
fun ChatSheet(chat: List<ChatMessage>, members: List<Member>, onSend: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Juntos.colors
    var draft by remember { mutableStateOf("") }
    val list = rememberLazyListState()
    LaunchedEffect(chat.size) { if (chat.isNotEmpty()) list.animateScrollToItem(chat.lastIndex) }
    val send = {
        val text = draft.trim()
        if (text.isNotEmpty()) { onSend(text); draft = "" }
    }
    JuntosSheet(onDismiss) {
        SheetTitle("Chat")
        if (chat.isEmpty()) {
            Box(Modifier.fillMaxWidth().heightIn(min = 160.dp), contentAlignment = Alignment.Center) {
                Text("Puxa assunto", color = c.textMuted, fontSize = JuntosTextSize.sm)
            }
        } else {
            LazyColumn(Modifier.fillMaxWidth().heightIn(min = 160.dp, max = 420.dp), state = list, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                items(chat) { message ->
                    val author = members.firstOrNull { it.nickname == message.author }
                    val hue = hueOf(author?.id ?: message.author) - 1
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.animateItem()) {
                        Avatar(author?.id ?: message.author, message.author, author?.avatar, 28.dp)
                        Column {
                            Text(message.author, color = c.hueInk.getOrElse(hue) { c.text }, fontSize = JuntosTextSize.xs, fontWeight = FontWeight.SemiBold)
                            Text(message.text, color = c.text, fontSize = JuntosTextSize.base)
                        }
                    }
                }
            }
        }
        Row(
            Modifier.fillMaxWidth().imePadding().padding(top = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Field(value = draft, onValueChange = { draft = it }, label = "Mensagem", modifier = Modifier.weight(1f), onSubmit = send)
            IconPill("Enviar", JuntosIcons.Send, onClick = send, tone = PillTone.Primary, enabled = draft.isNotBlank())
        }
    }
}

@Composable
fun PeopleSheet(members: List<Member>, me: String?, controllerId: String?, pinned: String?, onPin: (String) -> Unit, onDismiss: () -> Unit) {
    val c = Juntos.colors
    JuntosSheet(onDismiss) {
        SheetTitle("Pessoas na sala")
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 480.dp)) {
            items(members, key = { it.id }) { m ->
                Row(
                    Modifier.fillMaxWidth().animateItem().padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Avatar(m.id, m.nickname, m.avatar, 36.dp)
                    Text(
                        m.nickname + if (m.id == me) " (você)" else "",
                        color = c.text,
                        fontSize = JuntosTextSize.base,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    if (m.id == controllerId) Text("👑", fontSize = JuntosTextSize.sm)
                    Icon(
                        if (m.mic == true) JuntosIcons.Mic else JuntosIcons.MicOff,
                        contentDescription = if (m.mic == true) "Microfone ligado" else "Microfone desligado",
                        tint = if (m.mic == true) c.textMuted else c.dangerInk,
                        modifier = Modifier.size(16.dp),
                    )
                    Icon(
                        if (m.cam == true) JuntosIcons.Cam else JuntosIcons.CamOff,
                        contentDescription = if (m.cam == true) "Câmera ligada" else "Câmera desligada",
                        tint = if (m.cam == true) c.textMuted else c.dangerInk,
                        modifier = Modifier.size(16.dp),
                    )
                    IconPill(if (m.id == pinned) "Desafixar ${m.nickname}" else "Fixar ${m.nickname}", JuntosIcons.Pin, onClick = { onPin(m.id) }, active = m.id == pinned, size = 32.dp)
                }
            }
        }
    }
}
