package lol.juntos.app.room

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import lol.juntos.design.Field
import lol.juntos.design.IconPill
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.Pill
import lol.juntos.design.PillSize
import lol.juntos.design.PillTone
import lol.juntos.design.SpringRow
import lol.juntos.design.pop
import lol.juntos.design.settle

private val VIDEO_EXTENSIONS = setOf("mkv", "mp4", "m4v", "webm", "avi", "mov", "ts", "m2ts")

private sealed interface Step {
    data object Menu : Step
    data class Link(val torrent: Boolean) : Step
    data class Files(val torrent: OpenedTorrent) : Step
}

/**
 * Compartilhar, as the site's menu: the sources this phone can bring to the room. The
 * drawer grows and shrinks with each step on the spring: the list, a link, a torrent's files.
 */
@Composable
internal fun ShareSheet(host: LocalHost, onHost: suspend (LocalSource) -> Unit, onDismiss: () -> Unit) {
    val c = Juntos.colors
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<Step>(Step.Menu) }
    var link by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun go(next: Step) {
        error = null
        step = next
    }

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

    fun open(torrent: Boolean) {
        val text = link.trim()
        when {
            torrent && text.startsWith("magnet:?") -> run { go(Step.Files(host.openTorrent(text))) }
            !torrent && text.contains("youtu") -> run {
                onHost(host.resolveYoutube(text))
                onDismiss()
            }
            else -> error = if (torrent) "Cole um link magnet." else "Cole um link do YouTube."
        }
    }

    JuntosSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().animateContentSize(pop())) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (step != Step.Menu) IconPill("Voltar", JuntosIcons.Back, onClick = { go(Step.Menu) }, size = 36.dp)
                Text(titleOf(step), color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, maxLines = 1)
            }
            val enter = pop<Float>()
            val exit = settle<Float>()
            AnimatedContent(
                targetState = step,
                transitionSpec = { (fadeIn(enter) + scaleIn(enter, initialScale = 0.96f)) togetherWith fadeOut(exit) },
                label = "share-step",
            ) { shown ->
                when (shown) {
                    Step.Menu -> Column {
                        SpringRow("YouTube", icon = JuntosIcons.Youtube, onClick = { link = ""; go(Step.Link(torrent = false)) })
                        SpringRow("Torrent", icon = JuntosIcons.Magnet, onClick = { link = ""; go(Step.Link(torrent = true)) })
                    }
                    is Step.Link -> Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Field(
                            value = link,
                            onValueChange = { link = it },
                            label = "Link",
                            placeholder = if (shown.torrent) "magnet:?" else "youtube.com/watch?v=…",
                            modifier = Modifier.fillMaxWidth(),
                            onSubmit = { open(shown.torrent) },
                        )
                        Pill("Abrir", onClick = { open(shown.torrent) }, tone = PillTone.Brand, size = PillSize.Lg, loading = busy, enabled = link.isNotBlank(), modifier = Modifier.fillMaxWidth())
                    }
                    is Step.Files -> {
                        val opened = shown.torrent
                        val videos = opened.files.filter { it.path.substringAfterLast('.').lowercase() in VIDEO_EXTENSIONS }.ifEmpty { opened.files }
                        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                            videos.sortedBy { it.path }.forEach { file ->
                                val name = file.path.substringAfterLast('/')
                                SpringRow(name, icon = JuntosIcons.Film, onClick = {
                                    run {
                                        onHost(LocalSource.Torrent(opened.id, file.index, name.substringBeforeLast('.'), opened.magnet))
                                        onDismiss()
                                    }
                                })
                            }
                        }
                    }
                }
            }
            error?.let { Text(it, color = c.danger, fontSize = JuntosTextSize.xs, modifier = Modifier.padding(top = 8.dp, start = 4.dp)) }
        }
    }
}

private fun titleOf(step: Step): String = when (step) {
    Step.Menu -> "Compartilhar"
    is Step.Link -> if (step.torrent) "Torrent" else "YouTube"
    is Step.Files -> step.torrent.name
}
