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
import androidx.compose.foundation.layout.size
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
import kotlinx.serialization.json.JsonElement
import lol.juntos.app.extensions.ExtensionError
import lol.juntos.app.extensions.ExtensionShelf
import lol.juntos.app.extensions.Fresh
import lol.juntos.app.extensions.extensionErrorText
import lol.juntos.core.extensions.Installed
import lol.juntos.design.ConfirmDialog
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
    data object Extensions : Step
    data object AddExtension : Step
}

/** A version waiting for the person's yes; [current] opens instead when they say no to an update. */
private data class Pending(val extension: Pair<Installed, JsonElement>, val update: Boolean, val current: Installed? = null)

/**
 * Compartilhar, as the site's menu: the sources this phone can bring to the room. The
 * drawer grows and shrinks with each step on the spring: the list, a link, a torrent's files.
 */
@Composable
internal fun ShareSheet(
    host: LocalHost,
    shelf: ExtensionShelf,
    onHost: suspend (LocalSource) -> Unit,
    onOpenExtension: (Installed) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = Juntos.colors
    val scope = rememberCoroutineScope()
    var step by remember { mutableStateOf<Step>(Step.Menu) }
    var link by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var installed by remember { mutableStateOf(shelf.installed()) }
    var extensionId by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<Pending?>(null) }

    fun go(next: Step) {
        error = null
        step = next
    }

    fun run(fallback: String, block: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                block()
            } catch (e: ExtensionError) {
                error = extensionErrorText(e.code)
            } catch (e: Exception) {
                android.util.Log.w("ShareSheet", fallback, e)
                error = shareError(e.message, fallback)
            } finally {
                busy = false
            }
        }
    }

    fun open(torrent: Boolean) {
        val text = link.trim()
        when {
            torrent && text.startsWith("magnet:?") -> run("Não deu para abrir esse magnet.") { go(Step.Files(host.openTorrent(text))) }
            !torrent && text.contains("youtu") -> run("Não deu para abrir esse link.") {
                onHost(host.resolveYoutube(text))
                onDismiss()
            }
            else -> error = if (torrent) "Cole um link magnet." else "Cole um link do YouTube."
        }
    }

    fun openExtension(extension: Installed) {
        onOpenExtension(extension)
        onDismiss()
    }

    fun openInstalled(extension: Installed) = run("Não deu certo. Tente de novo") {
        when (val fresh = shelf.fresh(extension)) {
            is Fresh.Ready -> {
                installed = shelf.installed()
                openExtension(fresh.extension)
            }
            is Fresh.Approve -> pending = Pending(fresh.extension, update = true, current = extension)
        }
    }

    fun fetchExtension() = run("Não deu certo. Tente de novo") {
        val found = shelf.latest(extensionId)
        pending = Pending(found, update = installed.any { it.id == found.first.id })
    }

    JuntosSheet(onDismiss) {
        Column(Modifier.fillMaxWidth().animateContentSize(pop())) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val back = when (step) {
                    Step.Menu -> null
                    Step.AddExtension -> Step.Extensions
                    else -> Step.Menu
                }
                if (back != null) IconPill("Voltar", JuntosIcons.Back, onClick = { go(back) }, size = 36.dp)
                Text(titleOf(step), color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.weight(1f))
                if (busy && (step is Step.Files || step == Step.Extensions)) {
                    androidx.compose.material3.CircularProgressIndicator(color = c.textMuted, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
                }
                if (step == Step.Extensions) IconPill("Adicionar", JuntosIcons.Plus, onClick = { extensionId = ""; go(Step.AddExtension) }, size = 36.dp)
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
                        SpringRow("Extensões", icon = JuntosIcons.Puzzle, onClick = {
                            installed = shelf.installed()
                            go(Step.Extensions)
                            scope.launch {
                                runCatching { shelf.ensureDefaults() }
                                installed = shelf.installed()
                            }
                        })
                    }
                    Step.Extensions -> Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                        if (installed.isEmpty()) {
                            Text("Nenhuma extensão.", color = c.textMuted, fontSize = JuntosTextSize.sm, modifier = Modifier.padding(vertical = 12.dp, horizontal = 4.dp))
                        }
                        installed.forEach { extension ->
                            SpringRow(extension.manifest.name, icon = JuntosIcons.Puzzle, onClick = { if (!busy) openInstalled(extension) })
                        }
                    }
                    Step.AddExtension -> Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Field(
                            value = extensionId,
                            onValueChange = { extensionId = it },
                            label = "ID da extensão",
                            mono = true,
                            modifier = Modifier.fillMaxWidth(),
                            onSubmit = { fetchExtension() },
                        )
                        Pill("Buscar", onClick = { fetchExtension() }, tone = PillTone.Brand, size = PillSize.Lg, loading = busy, enabled = extensionId.isNotBlank(), modifier = Modifier.fillMaxWidth())
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
                                    run("Não deu para começar esse arquivo.") {
                                        val title = name.substringBeforeLast('.')
                                        onHost(
                                            opened.fleetJob?.let { LocalSource.Fleet(it, file.index, title, name) }
                                                ?: LocalSource.Torrent(opened.id, file.index, title, opened.magnet, file.size),
                                        )
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
    pending?.let { asked ->
        val name = asked.extension.first.manifest.name
        ConfirmDialog(
            title = if (asked.update) "Atualizar $name?" else "Instalar $name?",
            confirm = if (asked.update) "Atualizar" else "Instalar",
            icon = JuntosIcons.Puzzle,
            onConfirm = {
                pending = null
                shelf.install(asked.extension)
                installed = shelf.installed()
                extensionId = ""
                openExtension(asked.extension.first)
            },
            onCancel = {
                pending = null
                asked.current?.let(::openExtension)
            },
        )
    }
}

/** What went wrong, in words: the producer's codes and the usual failures, else [fallback]. */
internal fun shareError(message: String?, fallback: String): String {
    val m = message.orEmpty()
    return when {
        m == "live" -> "Transmissão ao vivo ainda não roda no celular."
        m == "tools_missing" -> "Não deu para preparar o YouTube neste celular."
        m == "invalid_magnet" -> "Esse magnet não é válido."
        m.contains("metadata timed out") || m.contains("initialization timed out") -> "O torrent não respondeu. Tente de novo ou use outro magnet."
        m.contains("No space", ignoreCase = true) || m.contains("ENOSPC") -> "O celular está sem espaço."
        m == "quota_exceeded" || m == "concurrent_jobs" -> "Muitos torrents abertos agora. Tente daqui a pouco."
        m == "no_workers" || m == "workers_busy" -> "Os servidores de torrent estão cheios. Tente daqui a pouco."
        m == "blocked" -> "Esse torrent não pode ser aberto aqui."
        else -> fallback
    }
}

private fun titleOf(step: Step): String = when (step) {
    Step.Menu -> "Compartilhar"
    is Step.Link -> if (step.torrent) "Torrent" else "YouTube"
    is Step.Files -> step.torrent.name
    Step.Extensions, Step.AddExtension -> "Extensões"
}
