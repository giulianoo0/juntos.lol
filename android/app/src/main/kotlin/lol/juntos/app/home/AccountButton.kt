package lol.juntos.app.home

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import android.content.Intent
import android.net.Uri
import androidx.compose.ui.platform.LocalContext
import lol.juntos.app.LOGIN_VERIFIER
import lol.juntos.app.entry.Prefs
import lol.juntos.core.account.newVerifier
import lol.juntos.app.room.JuntosSheet
import lol.juntos.core.account.Accounts
import lol.juntos.design.Avatar
import lol.juntos.design.Juntos
import lol.juntos.design.DiscordMark
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.Pill
import lol.juntos.design.PillTone
import lol.juntos.design.pressScale

/** The header's account: Discord's sign-in for a guest, the account's face (and its sheet) once signed in. */
@Composable
fun AccountButton(accounts: Accounts, prefs: Prefs) {
    val c = Juntos.colors
    val scope = rememberCoroutineScope()
    val me by accounts.me.collectAsState()
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }

    val signed = me
    if (signed == null) {
        Row(
            Modifier
                .pressScale(interaction)
                .height(36.dp)
                .clip(CircleShape)
                .background(c.discord)
                .clickable(interaction, indication = null, role = Role.Button) {
                    // In the person's own browser, where Discord already knows them.
                    val verifier = newVerifier()
                    prefs.put(LOGIN_VERIFIER, verifier)
                    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(accounts.startUrl(verifier)))) }
                }
                .padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(DiscordMark, contentDescription = null, tint = Color.White, modifier = Modifier.size(width = 18.dp, height = 13.5.dp))
            Text("Entrar com Discord", color = Color.White, fontSize = JuntosTextSize.sm, fontWeight = FontWeight.Medium, maxLines = 1)
        }
    } else {
        Avatar(
            id = signed.id.toString(),
            name = signed.nickname,
            avatar = signed.avatar,
            size = 36.dp,
            modifier = Modifier
                .pressScale(interaction)
                .clip(CircleShape)
                .clickable(interaction, indication = null, role = Role.Button, onClickLabel = "${signed.nickname} #${signed.id}") { open = true },
        )
    }

    if (open && signed != null) {
        JuntosSheet(onDismiss = { open = false }) {
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(signed.id.toString(), signed.nickname, signed.avatar, 44.dp)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(signed.nickname, color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, maxLines = 1)
                    Text("#${signed.id}", color = c.textMuted, fontSize = JuntosTextSize.sm, maxLines = 1)
                }
            }
            Spacer(Modifier.height(12.dp))
            Pill(
                "Sair",
                onClick = { open = false; scope.launch { accounts.signOut() } },
                modifier = Modifier.fillMaxWidth(),
                tone = PillTone.Soft,
                icon = JuntosIcons.Leave,
            )
        }
    }
}
