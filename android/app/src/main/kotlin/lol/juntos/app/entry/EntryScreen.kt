package lol.juntos.app.entry

import androidx.compose.animation.EnterExitState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import lol.juntos.app.LocalNavScope
import lol.juntos.app.door
import lol.juntos.design.IconPill
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosMotion
import lol.juntos.design.JuntosRadii
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.LocalMotionEnabled
import lol.juntos.design.Mascot
import lol.juntos.design.MascotAccessories
import lol.juntos.design.MascotImage
import lol.juntos.design.MascotKinds
import lol.juntos.design.Field
import lol.juntos.design.Pill
import lol.juntos.design.PillSize
import lol.juntos.design.PillTone
import lol.juntos.design.mascotOf
import lol.juntos.design.pop
import lol.juntos.design.pressScale
import lol.juntos.design.settle
import lol.juntos.design.springBlur

private val KIND_NAMES = mapOf(
    "wolf" to "Lobo", "cat" to "Gato", "fox" to "Raposa", "bunny" to "Coelho", "bear" to "Urso", "frog" to "Sapo",
    "penguin" to "Pinguim", "owl" to "Coruja", "panda" to "Panda", "koala" to "Coala", "axolotl" to "Axolote",
    "octopus" to "Polvo", "bee" to "Abelha", "robot" to "Robô", "alien" to "Alien", "ghost" to "Fantasma",
    "mushroom" to "Cogumelo", "cactus" to "Cacto", "strawberry" to "Morango", "avocado" to "Abacate",
    "cloud" to "Nuvem", "drop" to "Gota", "flame" to "Chama", "planet" to "Planeta", "slime" to "Slime",
    "popcorn" to "Pipoca", "onigiri" to "Onigiri", "dice" to "Dado",
)

private val ACCESSORY_NAMES = mapOf(
    "bowtie" to "Gravata-borboleta", "headphones" to "Fone", "cat-headphones" to "Fone de gato",
    "sunglasses" to "Óculos escuros", "round-glasses" to "Óculos redondos", "beanie" to "Gorro", "cap" to "Boné",
    "crown" to "Coroa", "bow" to "Laço", "flower" to "Flor", "scarf" to "Cachecol",
    "space-helmet" to "Capacete espacial", "none" to "Nenhum",
)

private const val KINDS_PER_ROW = 6

/**
 * The door before a room, as the site's on a phone: the room's name on top, your mascot
 * on its stage with what it wears under it, your name, the creatures, and Entrar held at
 * the bottom over the keyboard.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun EntryScreen(
    roomName: String?,
    me: Me,
    busy: Boolean,
    door: String?,
    onEnter: (nickname: String, avatar: String) -> Unit,
    onBack: () -> Unit,
) {
    val c = Juntos.colors
    var nickname by rememberSaveable { mutableStateOf(me.nickname) }
    var avatar by rememberSaveable { mutableStateOf(me.avatar) }
    val mascot = mascotOf(avatar) ?: Mascot(MascotKinds.first(), "bowtie")
    val enter = { if (!busy) onEnter(nicknameToEnter(nickname), mascot.avatar) }
    val keyboard = WindowInsets.isImeVisible
    val closing = LocalNavScope.current?.transition?.targetState == EnterExitState.PostExit

    Column(
        Modifier
            .fillMaxSize()
            .door(door, 36.dp, closing = closing)
            .background(c.frameGround)
            .imePadding(),
    ) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconPill("Voltar", JuntosIcons.Back, onClick = onBack)
            Text(
                roomName.orEmpty(),
                color = c.text,
                fontSize = JuntosTextSize.lg,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f).padding(horizontal = 8.dp),
            )
            Spacer(Modifier.size(44.dp))
        }
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Stage(mascot, small = keyboard, onWear = { avatar = mascot.copy(accessory = it).avatar })
            Field(
                value = nickname,
                onValueChange = { nickname = fitNickname(it) },
                label = "Seu nome",
                modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth(),
                onSubmit = enter,
            )
            Kinds(mascot, onPick = { avatar = mascot.copy(kind = it).avatar })
            Spacer(Modifier.height(4.dp))
        }
        Box(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp), contentAlignment = Alignment.Center) {
            Pill(
                "Entrar",
                onClick = enter,
                tone = PillTone.Brand,
                size = PillSize.Lg,
                loading = busy,
                modifier = Modifier.widthIn(max = 480.dp).fillMaxWidth().door("door-entry", 22.dp),
            )
        }
    }
}

/** The mascot on its ground, bobbing; every new look pops it in again, and what it can wear runs under it. */
@Composable
private fun Stage(mascot: Mascot, small: Boolean, onWear: (String) -> Unit) {
    val c = Juntos.colors
    val motion = LocalMotionEnabled.current
    val size by animateDpAsState(if (small) 96.dp else 148.dp, if (small) settle() else pop(), label = "hero-size")
    val bounce = remember { Animatable(1f) }
    LaunchedEffect(mascot) {
        if (!motion) return@LaunchedEffect
        bounce.snapTo(0.85f)
        bounce.animateTo(1f, tween(JuntosMotion.POP_MS, easing = JuntosMotion.SpringPop))
    }
    val bob = if (motion) {
        rememberInfiniteTransition(label = "bob").animateFloat(
            0f,
            1f,
            infiniteRepeatable(tween(1_700, easing = JuntosMotion.EaseInOut), RepeatMode.Reverse),
            label = "bob-y",
        )
    } else {
        null
    }
    Column(
        Modifier
            .widthIn(max = 480.dp)
            .fillMaxWidth()
            .clip(RoundedCornerShape(JuntosRadii.xl3))
            .background(c.tile)
            .background(Brush.verticalGradient(listOf(Color.Transparent, c.primary.copy(alpha = 0.12f))))
            .padding(vertical = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        MascotImage(
            mascot,
            size,
            Modifier
                .graphicsLayer {
                    translationY = -8.dp.toPx() * (bob?.value ?: 0f)
                    scaleX = bounce.value
                    scaleY = bounce.value
                }
                .springBlur((4f * ((1f - bounce.value) / 0.15f).coerceIn(0f, 1f)).dp),
        )
        Accessories(mascot, onWear)
    }
}

@Composable
private fun Accessories(mascot: Mascot, onWear: (String) -> Unit) {
    val list = rememberLazyListState(MascotAccessories.indexOf(mascot.accessory).coerceAtLeast(0))
    LazyRow(
        Modifier.fillMaxWidth().selectableGroup().semantics { contentDescription = "Acessório" },
        state = list,
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        items(MascotAccessories, key = { it }) { accessory ->
            Choice(
                name = ACCESSORY_NAMES.getValue(accessory),
                chosen = accessory == mascot.accessory,
                onClick = { onWear(accessory) },
                modifier = Modifier.size(56.dp),
            ) { MascotImage(mascot.copy(accessory = accessory), 44.dp) }
        }
    }
}

/** Every creature, wearing what you wear now. */
@Composable
private fun Kinds(mascot: Mascot, onPick: (String) -> Unit) {
    Column(
        Modifier.widthIn(max = 480.dp).fillMaxWidth().selectableGroup().semantics { contentDescription = "Bicho" },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        MascotKinds.chunked(KINDS_PER_ROW).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { kind ->
                    Choice(
                        name = KIND_NAMES[kind] ?: kind,
                        chosen = kind == mascot.kind,
                        onClick = { onPick(kind) },
                        modifier = Modifier.weight(1f).aspectRatio(1f),
                    ) { MascotImage(mascot.copy(kind = kind), 40.dp) }
                }
                repeat(KINDS_PER_ROW - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

/** One tile of a picker: the chosen one lifts onto the surface with the brand's ring. */
@Composable
private fun Choice(name: String, chosen: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = Juntos.colors
    val interaction = remember { MutableInteractionSource() }
    val shape = RoundedCornerShape(JuntosRadii.xl)
    Box(
        modifier
            .pressScale(interaction, 0.94f)
            .clip(shape)
            .background(if (chosen) c.surface else c.buttonSecondary)
            .border(2.dp, if (chosen) c.brand else Color.Transparent, shape)
            .selectable(chosen, interaction, indication = null, role = Role.RadioButton, onClick = onClick)
            .semantics { contentDescription = name },
        contentAlignment = Alignment.Center,
    ) { content() }
}
