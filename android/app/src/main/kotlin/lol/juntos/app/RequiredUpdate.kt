package lol.juntos.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Download
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Column
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import lol.juntos.app.room.JuntosSheet
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.Pill
import lol.juntos.design.PillSize
import lol.juntos.design.PillTone
import lol.juntos.update.UpdateState
import lol.juntos.update.Updater
import kotlin.math.roundToInt

/** Below the manifest's minimum, the update is asked for in a drawer, over home and room alike, once per launch. */
@Composable
fun RequiredUpdate(updater: Updater) {
    val state by updater.state.collectAsState()
    val scope = rememberCoroutineScope()
    var dismissed by remember { mutableStateOf(false) }
    var asked by remember { mutableStateOf<String?>(null) }
    when (val now = state) {
        is UpdateState.Available -> asked = if (now.required) now.release.versionName else null
        is UpdateState.UpToDate -> asked = null
        else -> Unit
    }
    val version = asked
    if (version == null || dismissed) return
    val busy = state is UpdateState.Downloading || state is UpdateState.Installing
    val label = when (val now = state) {
        is UpdateState.Downloading -> "Baixando ${(now.fraction * 100).roundToInt()}%"
        is UpdateState.Installing -> "Instalando"
        is UpdateState.Failed -> "Tentar de novo"
        else -> "Atualizar para $version"
    }
    JuntosSheet(onDismiss = { if (!busy) dismissed = true }) {
        Text(
            "Essa versão do juntos pode não funcionar mais",
            color = Juntos.colors.text,
            fontSize = JuntosTextSize.lg,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(top = 8.dp, bottom = 20.dp),
        )
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Pill(
                label,
                onClick = {
                    scope.launch {
                        if (state is UpdateState.Failed) updater.check()
                        updater.install()
                    }
                },
                modifier = Modifier.fillMaxWidth(),
                tone = PillTone.Brand,
                size = PillSize.Lg,
                icon = Icons.Rounded.Download,
                loading = busy,
                enabled = !busy,
            )
            Pill("Agora não", onClick = { dismissed = true }, modifier = Modifier.fillMaxWidth(), size = PillSize.Lg, enabled = !busy)
        }
    }
}
