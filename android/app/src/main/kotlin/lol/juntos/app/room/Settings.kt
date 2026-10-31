package lol.juntos.app.room

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material.icons.rounded.UploadFile
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import lol.juntos.design.Field
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosFonts
import lol.juntos.design.JuntosMotion
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.Pill
import lol.juntos.design.Segmented
import lol.juntos.design.SpringRow
import lol.juntos.design.ToastHost
import lol.juntos.design.rememberToastState
import lol.juntos.design.pressScale
import lol.juntos.player.JuntosPlayer

private enum class Tab(val label: String) { Audio("Áudio"), Subtitles("Legendas"), Quality("Qualidade") }

private val SUBTITLE_TYPES = arrayOf("application/x-subrip", "text/vtt", "text/x-ssa", "text/plain", "application/octet-stream")
private const val HOLD_DELAY_MS = 450L
private const val HOLD_INTERVAL_MS = 120L

@Composable
fun SettingsSheet(player: JuntosPlayer, onDismiss: () -> Unit) {
    val toasts = rememberToastState()
    val scope = rememberCoroutineScope()
    JuntosSheet(onDismiss) {
        Box {
            SettingsPanel(player, onNotice = { scope.launch { toasts.show(it) } })
            ToastHost(toasts, Modifier.align(Alignment.BottomCenter))
        }
    }
}

/** Áudio, Legendas and, when the stream has them, Qualidade: what this viewer picks for themselves. */
@Composable
fun SettingsPanel(player: JuntosPlayer, onNotice: (String) -> Unit) {
    val snapshot by player.snapshot.collectAsState()
    val tabs = listOfNotNull(Tab.Audio, Tab.Subtitles, Tab.Quality.takeIf { snapshot.qualities.isNotEmpty() })
    var tab by remember { mutableStateOf(Tab.Audio) }
    Column {
        Segmented(tabs, tab, onSelect = { tab = it }, label = { it.label }, fill = true, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp))
        AnimatedContent(
            tab,
            transitionSpec = { fadeIn(tween(JuntosMotion.BASE_MS)) togetherWith fadeOut(tween(JuntosMotion.FAST_MS)) },
            label = "settings-tab",
        ) { current ->
            Column(Modifier.fillMaxWidth().heightIn(min = 160.dp).padding(top = 4.dp)) {
                when (current) {
                    Tab.Audio -> snapshot.audio.forEach { track ->
                        SpringRow(track.label, onClick = { player.selectAudio(track.index) }, checked = track.selected)
                    }
                    Tab.Subtitles -> {
                        SpringRow("Desligadas", onClick = { player.selectSubtitle(null) }, checked = snapshot.subtitles.none { it.selected })
                        snapshot.subtitles.forEach { track ->
                            SpringRow(track.label, onClick = { player.selectSubtitle(track.index) }, checked = track.selected)
                        }
                        Row(
                            Modifier.fillMaxWidth().padding(top = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            ImportSubtitle(player, onNotice, Modifier.weight(1f))
                        }
                        Row(
                            Modifier.fillMaxWidth().padding(top = 12.dp, start = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("Atraso da legenda", color = Juntos.colors.text, fontSize = JuntosTextSize.sm, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
                            DelayControl(snapshot.subtitleDelayMs, onChange = player::setSubtitleDelay)
                        }
                    }
                    Tab.Quality -> {
                        SpringRow("Automática", onClick = { player.selectQuality(null) }, checked = snapshot.qualities.none { it.selected })
                        snapshot.qualities.forEach { q ->
                            SpringRow(q.label, onClick = { player.selectQuality(q.index) }, checked = q.selected)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ImportSubtitle(player: JuntosPlayer, onNotice: (String) -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val read = withContext(Dispatchers.IO) { runCatching { context.readSubtitle(uri) }.getOrNull() }
            val index = read?.let { (name, text) -> player.importSubtitle(name, text) }
            onNotice(if (index != null) "Legenda importada" else "Esse arquivo de legenda não é suportado. Use SRT, ASS, SSA ou VTT.")
        }
    }
    Pill("Importar arquivo", onClick = { pick.launch(SUBTITLE_TYPES) }, icon = Icons.Rounded.UploadFile, modifier = modifier)
}

private fun Context.readSubtitle(uri: Uri): Pair<String, String>? {
    val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
    } ?: uri.lastPathSegment?.substringAfterLast('/') ?: "legenda"
    val bytes = contentResolver.openInputStream(uri)?.use { it.readNBytes(SUBTITLE_MAX_BYTES + 1) } ?: return null
    return decodeSubtitle(bytes)?.let { name to it }
}

/** Minus, the value, plus. A tap steps a quarter second, holding keeps stepping, the value opens a field. */
@Composable
fun DelayControl(valueMs: Long, onChange: (Long) -> Unit) {
    val c = Juntos.colors
    var editing by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    Row(
        Modifier.height(36.dp).clip(CircleShape).background(c.buttonSecondary).padding(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Stepper("Menos atraso", Icons.Rounded.Remove, -1, valueMs, onChange)
        Box(Modifier.width(84.dp), contentAlignment = Alignment.Center) {
            val draft = editing
            if (draft == null) {
                Text(
                    formatDelay(valueMs),
                    color = c.text,
                    fontFamily = JuntosFonts.mono,
                    fontSize = JuntosTextSize.sm,
                    modifier = Modifier
                        .clip(CircleShape)
                        .clickable(role = Role.Button) { editing = editableDelay(valueMs) }
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                )
            } else {
                val commit = {
                    parseDelay(draft)?.let(onChange)
                    editing = null
                }
                Field(
                    value = draft,
                    onValueChange = { editing = it },
                    label = "Atraso da legenda",
                    placeholder = "",
                    mono = true,
                    onSubmit = commit,
                    modifier = Modifier.focusRequester(focus).height(32.dp),
                )
                androidx.compose.runtime.LaunchedEffect(Unit) { focus.requestFocus() }
            }
        }
        Stepper("Mais atraso", Icons.Rounded.Add, 1, valueMs, onChange)
    }
}

@Composable
private fun Stepper(label: String, icon: ImageVector, direction: Int, valueMs: Long, onChange: (Long) -> Unit) {
    val c = Juntos.colors
    val latest by rememberUpdatedState(valueMs)
    val change by rememberUpdatedState(onChange)
    val scope = rememberCoroutineScope()
    val interaction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
    Box(
        Modifier
            .pressScale(interaction, 0.9f)
            .size(32.dp)
            .clip(CircleShape)
            .semantics { contentDescription = label; role = Role.Button }
            .pointerInput(direction) {
                awaitEachGesture {
                    awaitFirstDown()
                    // The gesture's own timeouts run on the frame clock, so a hold repeats in step with it.
                    val tap = withTimeoutOrNull(HOLD_DELAY_MS) { waitForUpOrCancellation() != null }
                    if (tap != null) {
                        if (tap) change(stepDelay(latest, direction))
                        return@awaitEachGesture
                    }
                    var acc = latest
                    while (true) {
                        acc = stepDelay(acc, direction)
                        change(acc)
                        if (withTimeoutOrNull(HOLD_INTERVAL_MS) { waitForUpOrCancellation() } != null || currentEvent.changes.none { it.pressed }) break
                    }
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = c.text, modifier = Modifier.size(16.dp))
    }
}
