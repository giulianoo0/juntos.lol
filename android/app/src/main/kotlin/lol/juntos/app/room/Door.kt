package lol.juntos.app.room

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import lol.juntos.core.sync.Door
import lol.juntos.design.Field
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.Pill
import lol.juntos.design.PillSize
import lol.juntos.design.PillTone
import lol.juntos.design.pop
import lol.juntos.design.settle

/** What stands between the member and the room: a password, the host's approval, a no. */
@Composable
fun DoorOverlay(door: Door, onPassword: (String) -> Unit, onLeave: () -> Unit) {
    val c = Juntos.colors
    val shown = door != Door.In && door != Door.Joining
    AnimatedVisibility(shown, enter = fadeIn(), exit = fadeOut()) {
        Box(Modifier.fillMaxSize().background(c.frameGround.copy(alpha = 0.92f)), contentAlignment = Alignment.Center) {
            androidx.compose.animation.AnimatedVisibility(
                visibleState = remember { androidx.compose.animation.core.MutableTransitionState(false) }.apply { targetState = true },
                enter = scaleIn(pop()) + fadeIn(),
                exit = scaleOut(settle()) + fadeOut(),
            ) {
                Column(
                    Modifier
                        .widthIn(max = 360.dp)
                        .fillMaxWidth()
                        .padding(16.dp)
                        .background(c.surface, RoundedCornerShape(22.dp))
                        .padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    when (door) {
                        Door.Password, Door.BadPassword -> {
                            var password by remember { mutableStateOf("") }
                            Text(if (door == Door.BadPassword) "Senha errada" else "Sala com senha", color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold)
                            Field(password, { password = it }, label = "Senha da sala", placeholder = "Senha", password = true, modifier = Modifier.fillMaxWidth(), onSubmit = { onPassword(password) })
                            Pill("Entrar", onClick = { onPassword(password) }, tone = PillTone.Primary, size = PillSize.Lg, enabled = password.isNotEmpty(), modifier = Modifier.fillMaxWidth())
                        }
                        Door.Lobby -> Text("Esperando o anfitrião deixar você entrar", color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold)
                        else -> Text("O anfitrião não deixou você entrar", color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold)
                    }
                    Pill("Voltar", onClick = onLeave, size = PillSize.Lg, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}
