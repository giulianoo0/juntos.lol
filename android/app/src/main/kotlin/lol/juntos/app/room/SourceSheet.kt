package lol.juntos.app.room

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import lol.juntos.design.Field
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.Pill
import lol.juntos.design.PillSize
import lol.juntos.design.PillTone
import lol.juntos.design.SpringRow

private val VIDEO_EXTENSIONS = setOf("mkv", "mp4", "m4v", "webm", "avi", "mov", "ts", "m2ts")

/** A YouTube link or a magnet, as the room's next video. */
@Composable
internal fun SourceSheet(host: LocalHost, onHost: suspend (LocalSource) -> Unit, onDismiss: () -> Unit) {
    val c = Juntos.colors
    val scope = rememberCoroutineScope()
    var link by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var torrent by remember { mutableStateOf<OpenedTorrent?>(null) }

    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                block()
            } catch (e: Exception) {
                error = when (e.message) {
                    "live" -> "Transmissão ao vivo ainda não roda no celular."
                    "tools_missing" -> "Não deu para preparar o YouTube neste celular."
                    else -> "Não deu para abrir esse link."
                }
            } finally {
                busy = false
            }
        }
    }

    fun open() {
        val text = link.trim()
        when {
            text.startsWith("magnet:?") -> run { torrent = host.openTorrent(text) }
            text.contains("youtu") -> run {
                onHost(host.resolveYoutube(text))
                onDismiss()
            }
            else -> error = "Cole um link do YouTube ou um magnet."
        }
    }

    JuntosSheet(onDismiss) {
        Text("Escolher vídeo", color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(vertical = 8.dp))
        val opened = torrent
        if (opened == null) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Field(value = link, onValueChange = { link = it }, label = "Link", placeholder = "YouTube ou magnet", modifier = Modifier.fillMaxWidth(), onSubmit = ::open)
                Pill("Abrir", onClick = ::open, tone = PillTone.Brand, size = PillSize.Lg, loading = busy, enabled = link.isNotBlank(), modifier = Modifier.fillMaxWidth())
            }
        } else {
            val videos = opened.files.filter { it.path.substringAfterLast('.').lowercase() in VIDEO_EXTENSIONS }.ifEmpty { opened.files }
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                videos.sortedBy { it.path }.forEach { file ->
                    SpringRow(file.path.substringAfterLast('/'), icon = JuntosIcons.Film, onClick = {
                        run {
                            onHost(LocalSource.Torrent(opened.id, file.index, file.path.substringAfterLast('/').substringBeforeLast('.'), opened.magnet))
                            onDismiss()
                        }
                    })
                }
            }
        }
        error?.let { Text(it, color = c.danger, fontSize = JuntosTextSize.xs, modifier = Modifier.padding(top = 8.dp, start = 4.dp)) }
    }
}
