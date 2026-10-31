package lol.juntos.app.home

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import lol.juntos.app.AppGraph
import lol.juntos.app.RoomEntry
import lol.juntos.app.door
import lol.juntos.design.Avatar
import lol.juntos.design.BetaBadge
import lol.juntos.design.Field
import lol.juntos.design.IconPill
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosFonts
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosMotion
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.LocalMotionEnabled
import lol.juntos.design.Pill
import lol.juntos.design.PillSize
import lol.juntos.design.PillTone
import lol.juntos.design.SpringPopover
import lol.juntos.design.pop
import lol.juntos.design.pressScale
import lol.juntos.design.settle

private val WORDS = listOf("assistir", "conversar", "maratonar", "jogar", "ouvir", "zoar", "rir")
private val COUCH = listOf("bunny", "robot", "fox", "mushroom", "bear")

@Composable
fun HomeScreen(graph: AppGraph, nickname: String, avatar: String, onOpen: (RoomEntry) -> Unit) {
    val c = Juntos.colors
    val scope = rememberCoroutineScope()
    var creating by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun create(name: String, password: String?) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                if (!graph.human.ensure()) error("human")
                val room = graph.api.createRoom(nickname, name.trim(), password)
                creating = false
                onOpen(RoomEntry(room.id, nickname, avatar, ownerToken = room.ownerToken, door = "door-create"))
            } catch (e: Exception) {
                error = "Não deu para criar a sala. Tente de novo."
            } finally {
                busy = false
            }
        }
    }

    fun join(code: String) {
        scope.launch {
            if (!graph.human.ensure()) return@launch
            val ticket = runCatching { graph.api.join(code) }.getOrNull()
            onOpen(RoomEntry(code, nickname, avatar, ticket = ticket, door = "door-join"))
        }
    }

    Box(Modifier.fillMaxSize().background(c.frameGround)) {
        Column(
            Modifier.fillMaxSize().safeDrawingPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
                BetaBadge()
            }
            Spacer(Modifier.height(36.dp))
            Arrive { Wordmark(ink = c.text, arrow = c.brand, modifier = Modifier.widthIn(max = 420.dp).fillMaxWidth(0.82f)) }
            Spacer(Modifier.height(32.dp))
            TurningTitle()
            Spacer(Modifier.height(32.dp))
            SpringPopover(
                expanded = creating,
                onExpandedChange = { creating = it; if (!it) error = null },
                width = 340.dp,
                trigger = { open -> CreateButton(onClick = open) },
            ) { CreateForm(busy = busy, error = error, onCreate = ::create) }
            Spacer(Modifier.height(16.dp))
            JoinByCode(onJoin = ::join)
            Spacer(Modifier.weight(1f).height(48.dp))
            Couch()
        }
    }
}

@Composable
private fun Arrive(content: @Composable () -> Unit) {
    val motion = LocalMotionEnabled.current
    val p = remember { Animatable(if (motion) 0f else 1f) }
    LaunchedEffect(Unit) { p.animateTo(1f, tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop)) }
    Box(
        Modifier
            .graphicsLayer {
                val s = 0.6f + 0.4f * p.value
                scaleX = s; scaleY = s
                alpha = p.value.coerceIn(0f, 1f)
            }
            .blur((8f * (1f - p.value).coerceIn(0f, 1f)).dp),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
private fun TurningTitle() {
    val c = Juntos.colors
    val motion = LocalMotionEnabled.current
    var i by remember { mutableIntStateOf(0) }
    LaunchedEffect(motion) {
        while (motion) {
            delay(2_200)
            i = (i + 1) % WORDS.size
        }
    }
    val style = androidx.compose.ui.text.TextStyle(
        fontFamily = JuntosFonts.display,
        fontWeight = FontWeight.ExtraBold,
        fontSize = 40.sp,
        lineHeight = 40.sp,
        letterSpacing = (-0.045).em,
        textAlign = TextAlign.Center,
    )
    val popSpec = pop<androidx.compose.ui.unit.IntOffset>()
    val settleSpec = settle<androidx.compose.ui.unit.IntOffset>()
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Bora ", style = style, color = c.text)
            AnimatedContent(
                targetState = WORDS[i],
                transitionSpec = {
                    (slideInVertically(popSpec) { it } + fadeIn(tween(JuntosMotion.BASE_MS)))
                        .togetherWith(slideOutVertically(settleSpec) { -it } + fadeOut(tween(JuntosMotion.FAST_MS)))
                },
                label = "word",
            ) { word -> Text(word, style = style, color = c.brand) }
        }
        Text("junto?", style = style, color = c.text)
    }
}

@Composable
private fun CreateButton(onClick: () -> Unit) {
    val c = Juntos.colors
    val interaction = remember { MutableInteractionSource() }
    Row(
        Modifier
            .door("door-create", 36.dp)
            .pressScale(interaction)
            .height(72.dp)
            .clip(CircleShape)
            .background(c.brand)
            .clickable(interaction, indication = null, role = Role.Button, onClick = onClick)
            .padding(horizontal = 44.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(JuntosIcons.Plus, contentDescription = null, tint = c.onBrand, modifier = Modifier.size(26.dp))
        Text(
            "Criar sala",
            color = c.onBrand,
            fontFamily = JuntosFonts.display,
            fontWeight = FontWeight.ExtraBold,
            fontSize = 24.sp,
            letterSpacing = (-0.02).em,
        )
    }
}

@Composable
private fun CreateForm(busy: Boolean, error: String?, onCreate: (String, String?) -> Unit) {
    var name by remember { mutableStateOf("") }
    var locked by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    val popSpec = pop<Float>()
    val settleSpec = settle<Float>()
    val submit = { onCreate(name, if (locked && password.isNotEmpty()) password else null) }
    Column(Modifier.padding(4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Field(value = name, onValueChange = { name = it.take(80) }, label = "Nome da sala", modifier = Modifier.weight(1f), onSubmit = submit)
            IconPill(label = "Senha", icon = JuntosIcons.Lock, active = locked, onClick = { locked = !locked })
        }
        AnimatedVisibility(
            visible = locked,
            enter = scaleIn(popSpec, transformOrigin = TransformOrigin(1f, 0f)) + expandVertically(pop()),
            exit = scaleOut(settleSpec, transformOrigin = TransformOrigin(1f, 0f)) + shrinkVertically(settle()),
        ) {
            Field(
                value = password,
                onValueChange = { password = it },
                label = "Senha da sala",
                placeholder = "Senha",
                password = true,
                modifier = Modifier.fillMaxWidth(),
                onSubmit = submit,
            )
        }
        Pill("Criar", onClick = submit, tone = PillTone.Brand, size = PillSize.Lg, loading = busy, modifier = Modifier.fillMaxWidth())
        if (error != null) Text(error, color = Juntos.colors.danger, fontSize = JuntosTextSize.xs, modifier = Modifier.padding(horizontal = 4.dp))
    }
}

@Composable
private fun JoinByCode(onJoin: (String) -> Unit) {
    val c = Juntos.colors
    var code by remember { mutableStateOf("") }
    val room = roomCodeFrom(code)
    Row(
        Modifier
            .door("door-join", 22.dp)
            .clip(CircleShape)
            .background(c.buttonSecondary)
            .padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Field(
            value = code,
            onValueChange = { code = it },
            label = "Código da sala",
            placeholder = "Tenho um código",
            mono = true,
            modifier = Modifier.width(196.dp),
            onSubmit = { room?.let(onJoin) },
        )
        Pill("Entrar", onClick = { room?.let(onJoin) }, size = PillSize.Sm, enabled = room != null)
    }
}

@Composable
private fun Couch() {
    val c = Juntos.colors
    val motion = LocalMotionEnabled.current
    Box(Modifier.fillMaxWidth().padding(bottom = 8.dp), contentAlignment = Alignment.BottomCenter) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(56.dp)
                .clip(androidx.compose.foundation.shape.RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp))
                .background(c.surface.copy(alpha = if (c.isDark) 0.5f else 0.7f)),
        )
        Row(Modifier.padding(bottom = 20.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            COUCH.forEachIndexed { i, kind ->
                val p = remember { Animatable(if (motion) 0f else 1f) }
                LaunchedEffect(Unit) {
                    delay(300L + i * 70L)
                    p.animateTo(1f, tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop))
                }
                Avatar(
                    id = kind,
                    name = kind,
                    avatar = kind,
                    size = 56.dp,
                    modifier = Modifier.graphicsLayer {
                        scaleX = p.value; scaleY = p.value
                        transformOrigin = TransformOrigin(0.5f, 1f)
                    },
                )
            }
        }
    }
}
