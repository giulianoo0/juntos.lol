package lol.juntos.app.social

import android.graphics.BitmapFactory
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Canvas
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.ErrorOutline
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import lol.juntos.core.social.ChatMessage
import lol.juntos.core.social.Friend
import lol.juntos.core.social.Inbox
import lol.juntos.core.social.MessageState
import lol.juntos.core.social.Where
import lol.juntos.design.Avatar
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosTextSize
import lol.juntos.design.pop
import lol.juntos.design.pressScale
import lol.juntos.design.settle

private val DiscordGreen = Color(0xFF23A55A)
private val DiscordIdle = Color(0xFFF0B232)
private val DiscordDnd = Color(0xFFF23F43)
private val Offline = Color(0xFF8E8E93)

fun presenceLabel(friend: Friend): String = when (friend.where) {
    Where.Room -> friend.presence.roomName?.let { "Em $it" } ?: "Numa sala"
    Where.Juntos -> "No juntos"
    Where.Discord -> when (friend.presence.discord) {
        "idle" -> "Ausente no Discord"
        "dnd" -> "Não perturbe"
        else -> "No Discord"
    }
    Where.Away -> "Fora"
}

/**
 * A friend's creature with where they are drawn on it, as the site draws it: a ring while
 * juntos is open (brand in a room), and their Discord picture tucked under, dotted with
 * their Discord status.
 */
@Composable
fun FriendFace(inbox: Inbox, friend: Friend, size: Dp) {
    val c = Juntos.colors
    val picture by produceState<androidx.compose.ui.graphics.ImageBitmap?>(null, friend.id) {
        value = withContext(Dispatchers.IO) {
            inbox.discordAvatar(friend.id)?.let { bytes -> runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }.getOrNull() }
        }
    }
    val ring = when (friend.where) {
        Where.Room -> c.brand
        Where.Juntos -> DiscordGreen
        else -> Color.Transparent
    }
    val dim = friend.where == Where.Away || friend.where == Where.Discord
    Box(Modifier.size(size + 8.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(size + 8.dp).border(2.dp, ring, CircleShape))
        Box(Modifier.alpha(if (dim) 0.6f else 1f)) { Avatar(friend.id.toString(), friend.nickname, friend.avatar, size) }
        picture?.let { image ->
            val mini = size * 0.46f
            Box(Modifier.align(Alignment.BottomEnd).size(mini)) {
                Image(
                    image, contentDescription = null, contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().border(2.dp, c.frameGround, CircleShape).clip(CircleShape),
                )
                val dot = when (friend.presence.discord) {
                    "online" -> DiscordGreen
                    "idle" -> DiscordIdle
                    "dnd" -> DiscordDnd
                    else -> Offline
                }
                Box(Modifier.align(Alignment.BottomEnd).offset(2.dp, 2.dp).size(mini * 0.4f).border(2.dp, c.frameGround, CircleShape).clip(CircleShape).background(dot))
            }
        }
    }
}

/** Who is around now, a row of faces; a tap opens the talk with them. */
@Composable
fun FriendsRow(inbox: Inbox, onOpen: (Long) -> Unit) {
    val state by inbox.state.collectAsState()
    val around = state.friends.orEmpty().filter { it.where != Where.Away }
    AnimatedVisibility(visible = around.isNotEmpty(), enter = fadeIn(pop()) + scaleIn(pop(), initialScale = 0.9f), exit = fadeOut(settle())) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp), contentPadding = PaddingValues(horizontal = 8.dp)) {
            items(around, key = { it.id }) { friend ->
                val unread = state.threads[friend.id]?.unread ?: 0
                FeedPerson(inbox, friend, unread, onClick = { onOpen(friend.id) })
            }
        }
    }
}

@Composable
private fun FeedPerson(inbox: Inbox, friend: Friend, unread: Int, onClick: () -> Unit) {
    val c = Juntos.colors
    val interaction = remember { MutableInteractionSource() }
    Box {
        Column(
            Modifier
                .width(76.dp)
                .pressScale(interaction)
                .clip(RoundedCornerShape(20.dp))
                .clickable(interaction, indication = null, role = Role.Button, onClick = onClick)
                .semantics { contentDescription = "${friend.nickname}, ${presenceLabel(friend)}" }
                .padding(vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            FriendFace(inbox, friend, 48.dp)
            Text(friend.nickname, color = c.text, fontSize = JuntosTextSize.sm, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (unread > 0) Badge(unread, Modifier.align(Alignment.TopEnd).offset((-4).dp, 4.dp))
    }
}

@Composable
fun Badge(count: Int, modifier: Modifier = Modifier) {
    val c = Juntos.colors
    Box(
        modifier.heightIn(min = 20.dp).widthIn(min = 20.dp).border(2.dp, c.frameGround, CircleShape).clip(CircleShape).background(c.brand).padding(horizontal = 5.dp),
        contentAlignment = Alignment.Center,
    ) { Text(if (count > 9) "9+" else count.toString(), color = c.onBrand, fontSize = JuntosTextSize.xs, fontWeight = FontWeight.ExtraBold) }
}

private val timeFormat = DateTimeFormatter.ofPattern("HH:mm")

private fun shortTime(at: java.time.Instant): String {
    val local = at.atZone(ZoneId.systemDefault())
    return if (local.toLocalDate() == LocalDate.now()) local.format(timeFormat)
    else local.format(DateTimeFormatter.ofPattern("d MMM", Locale.forLanguageTag("pt-BR")))
}

private fun dayLabel(at: java.time.Instant): String {
    val day = at.atZone(ZoneId.systemDefault()).toLocalDate()
    val today = LocalDate.now()
    return when (day) {
        today -> "Hoje"
        today.minusDays(1) -> "Ontem"
        else -> day.format(DateTimeFormatter.ofPattern("EEEE, d 'de' MMMM", Locale.forLanguageTag("pt-BR")))
    }
}

@Composable
internal fun TopBar(title: @Composable () -> Unit, onBack: () -> Unit) {
    val c = Juntos.colors
    Row(
        Modifier.fillMaxWidth().statusBarsPadding().height(60.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        RoundIcon(JuntosIcons.Back, "Voltar", onBack)
        title()
    }
    Box(Modifier.fillMaxWidth().height(1.dp).background(c.line))
}

@Composable
internal fun RoundIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    val c = Juntos.colors
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier.pressScale(interaction, 0.92f).size(44.dp).clip(CircleShape)
            .clickable(interaction, indication = null, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, contentDescription = null, tint = c.text, modifier = Modifier.size(22.dp)) }
}

/** Friends: who is around on top, then every conversation, the latest first. */
@Composable
fun FriendsScreen(inbox: Inbox, onOpen: (Long) -> Unit, onKey: () -> Unit, onBack: () -> Unit) {
    val c = Juntos.colors
    val state by inbox.state.collectAsState()
    LaunchedEffect(Unit) { inbox.refreshFriends() }
    val friends = state.friends.orEmpty()
    val ordered = friends.sortedWith(
        compareByDescending<Friend> { state.threads[it.id]?.messages?.lastOrNull()?.at }.thenBy { it.where.ordinal }.thenBy { it.nickname.lowercase() },
    )
    Column(Modifier.fillMaxSize().background(c.frameGround)) {
        TopBar(
            title = {
                Text("Amigos", color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (state.live) RoundIcon(Icons.Rounded.Key, "Chave das mensagens", onKey)
            },
            onBack = onBack,
        )
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { Spacer(Modifier.height(8.dp)); FriendsRow(inbox, onOpen); Spacer(Modifier.height(8.dp)) }
            if (state.friends != null && friends.isEmpty()) {
                item { Text("Nenhum amigo ainda", color = c.textMuted, fontSize = JuntosTextSize.sm, modifier = Modifier.fillMaxWidth().padding(32.dp)) }
            }
            items(ordered, key = { it.id }) { friend ->
                val thread = state.threads[friend.id]
                val last = thread?.messages?.lastOrNull()
                val interaction = remember { MutableInteractionSource() }
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 8.dp).pressScale(interaction, 0.98f).clip(RoundedCornerShape(18.dp))
                        .clickable(interaction, indication = null, role = Role.Button) { onOpen(friend.id) }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    FriendFace(inbox, friend, 40.dp)
                    Column(Modifier.weight(1f)) {
                        Text(friend.nickname, color = c.text, fontSize = JuntosTextSize.base, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (last != null) {
                            val unread = (thread.unread) > 0
                            Text(
                                last.text ?: "Mensagem de antes deste aparelho",
                                color = if (unread) c.text else c.textMuted, fontSize = JuntosTextSize.sm,
                                fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    if (last != null) {
                        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(shortTime(last.at), color = c.textFaint, fontSize = JuntosTextSize.xs)
                            if ((thread.unread) > 0) Badge(thread.unread)
                        }
                    }
                }
            }
        }
    }
}

/** One conversation: the bubbles, newest at the bottom, and the line to write. */
@Composable
fun ChatScreen(inbox: Inbox, friendId: Long, onBack: () -> Unit, onJoinRoom: (String) -> Unit) {
    val c = Juntos.colors
    val state by inbox.state.collectAsState()
    val friend = state.friends?.firstOrNull { it.id == friendId }
    val thread = state.threads[friendId]
    val messages = thread?.messages.orEmpty()
    val me = state.me
    var draft by remember { mutableStateOf("") }
    val list = rememberLazyListState()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val typing = (thread?.typingUntil ?: 0) > now

    DisposableEffect(friendId) {
        inbox.show(friendId)
        onDispose { inbox.show(null) }
    }
    LaunchedEffect(friendId, thread?.loaded, state.live) { if (thread?.loaded != true) inbox.load(friendId) }
    LaunchedEffect(thread?.typingUntil) {
        now = System.currentTimeMillis()
        val wait = (thread?.typingUntil ?: 0) - now
        if (wait > 0) { delay(wait + 50); now = System.currentTimeMillis() }
    }
    // Reversed: index 0 is the newest, so new messages land in view on their own.
    LaunchedEffect(messages.size) { if (list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0) }
    LaunchedEffect(list) {
        snapshotFlow { list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last ->
            if (last >= list.layoutInfo.totalItemsCount - 3) inbox.load(friendId, older = true)
        }
    }
    val lastMine = messages.lastOrNull { it.from == me }
    val seen = lastMine != null && lastMine.id > 0 && (thread?.theyRead ?: 0) >= lastMine.id

    Column(Modifier.fillMaxSize().background(c.frameGround).imePadding()) {
        TopBar(
            title = {
                if (friend != null) FriendFace(inbox, friend, 32.dp)
                Column(Modifier.weight(1f)) {
                    Text(friend?.nickname ?: "#$friendId", color = c.text, fontSize = JuntosTextSize.base, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
                friend?.presence?.roomId?.let { roomId ->
                    RoundIcon(JuntosIcons.Film, "Entrar na sala") { onJoinRoom(roomId) }
                }
                Box(Modifier.size(32.dp).semantics { contentDescription = "Cifrada de ponta a ponta" }, contentAlignment = Alignment.Center) {
                    Icon(JuntosIcons.Lock, contentDescription = null, tint = c.textMuted, modifier = Modifier.size(16.dp))
                }
            },
            onBack = onBack,
        )
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            state = list,
            reverseLayout = true,
            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
        ) {
            if (typing) item(key = "typing") { TypingBubble() }
            val reversed = messages.asReversed()
            items(reversed.size, key = { reversed[it].clientId.ifEmpty { reversed[it].id.toString() } }) { index ->
                val message = reversed[index]
                val newer = reversed.getOrNull(index - 1)
                val older = reversed.getOrNull(index + 1)
                val mine = message.from == me
                val sameDayAsOlder = older != null && dayLabel(older.at) == dayLabel(message.at)
                val joinsOlder = sameDayAsOlder && older.from == message.from && message.at.epochSecond - older.at.epochSecond < 300
                val joinsNewer = newer != null && newer.from == message.from && newer.at.epochSecond - message.at.epochSecond < 300 && dayLabel(newer.at) == dayLabel(message.at)
                Column(Modifier.fillMaxWidth().animateItem(fadeInSpec = null, fadeOutSpec = null, placementSpec = spring(dampingRatio = 0.72f, stiffness = 420f))) {
                    if (!sameDayAsOlder) DayChip(dayLabel(message.at))
                    Bubble(message, mine, joinsOlder, joinsNewer, seen && message == lastMine, onRetry = { inbox.retry(friendId, message.clientId) })
                }
            }
            if (thread?.loaded == true && messages.isEmpty()) {
                item { Text("Diga oi", color = c.textMuted, fontSize = JuntosTextSize.sm, modifier = Modifier.fillMaxWidth().padding(32.dp)) }
            }
        }
        Composer(
            draft = draft,
            onDraft = { draft = it; inbox.typing(friendId) },
            onSend = {
                val text = draft.trim()
                if (text.isNotEmpty()) {
                    inbox.send(friendId, text)
                    draft = ""
                }
            },
        )
    }
}

@Composable
private fun DayChip(label: String) {
    val c = Juntos.colors
    Box(Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 8.dp), contentAlignment = Alignment.Center) {
        Text(label, color = c.textMuted, fontSize = JuntosTextSize.xs, fontWeight = FontWeight.Medium,
            modifier = Modifier.clip(CircleShape).background(c.surface2).padding(horizontal = 12.dp, vertical = 3.dp))
    }
}

@Composable
private fun Bubble(message: ChatMessage, mine: Boolean, joinsOlder: Boolean, joinsNewer: Boolean, seen: Boolean, onRetry: () -> Unit) {
    val c = Juntos.colors
    val big = 18.dp
    val small = 6.dp
    val shape = if (mine) RoundedCornerShape(big, big, if (joinsNewer) big else small, big)
    else RoundedCornerShape(big, big, big, if (joinsNewer) big else small)
    val fill = when {
        message.text == null -> Color.Transparent
        message.state == MessageState.Failed -> c.dangerSoft
        mine -> c.brand
        else -> c.surface2
    }
    val ink = when {
        message.text == null -> c.textMuted
        message.state == MessageState.Failed -> c.dangerInk
        mine -> c.onBrand
        else -> c.text
    }
    // A message just sent leaves the composer: it rises from the field and springs into place.
    val launched = remember(message.clientId) { mine && message.state == MessageState.Sending }
    val rise = remember(message.clientId) { Animatable(if (launched) 0f else 1f) }
    LaunchedEffect(message.clientId) {
        if (launched) rise.animateTo(1f, spring(dampingRatio = 0.62f, stiffness = 380f))
    }
    val dim by animateFloatAsState(if (message.state == MessageState.Sending) 0.72f else 1f, tween(220), label = "sending")
    Column(
        Modifier.fillMaxWidth().padding(top = if (joinsOlder) 2.dp else 10.dp)
            .graphicsLayer {
                val p = rise.value
                transformOrigin = TransformOrigin(if (mine) 1f else 0f, 1f)
                translationY = (1f - p) * 64.dp.toPx()
                translationX = (1f - p) * -24.dp.toPx()
                scaleX = 0.9f + 0.1f * p
                scaleY = 0.9f + 0.1f * p
                alpha = (0.35f + 0.65f * p).coerceIn(0f, 1f)
            },
        horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
    ) {
        Box(
            Modifier.widthIn(max = 300.dp).alpha(dim).clip(shape).background(fill)
                .then(if (message.text == null) Modifier.border(1.dp, c.line, shape) else Modifier)
                .padding(horizontal = 13.dp, vertical = 8.dp),
        ) {
            Text(message.text ?: "Mensagem de antes deste aparelho", color = ink, fontSize = JuntosTextSize.base)
        }
        if (!joinsNewer) {
            Row(Modifier.padding(top = 3.dp, start = 4.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(message.at.atZone(ZoneId.systemDefault()).format(timeFormat), color = c.textFaint, fontSize = JuntosTextSize.xs)
                if (mine) when (message.state) {
                    MessageState.Failed -> Icon(Icons.Rounded.ErrorOutline, "Tentar de novo", tint = c.danger,
                        modifier = Modifier.size(16.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onRetry))
                    else -> Ticks(sending = message.state == MessageState.Sending, seen = seen)
                }
            }
        }
    }
}

/** The ticks: one drawn when the server has it, a second drawn beside it, in the brand's color, once it is seen. */
@Composable
private fun Ticks(sending: Boolean, seen: Boolean) {
    val c = Juntos.colors
    val drawSpec = spring<Float>(dampingRatio = 0.7f, stiffness = 300f)
    val one by animateFloatAsState(if (sending) 0.34f else 1f, drawSpec, label = "tick-one")
    val two by animateFloatAsState(if (seen) 1f else 0f, drawSpec, label = "tick-two")
    val tint by animateColorAsState(if (seen) c.brand else c.textFaint, tween(320), label = "tick-tint")
    val pulse = rememberInfiniteTransition(label = "tick-pulse")
    val breathe by pulse.animateFloat(1f, 0.35f, infiniteRepeatable(tween(550), RepeatMode.Reverse), label = "breathe")
    val pop = remember { Animatable(1f) }
    LaunchedEffect(seen) { if (seen) { pop.snapTo(0.7f); pop.animateTo(1f, spring(dampingRatio = 0.45f, stiffness = 500f)) } }
    val label = when { sending -> "Enviando"; seen -> "Vista"; else -> "Enviada" }
    Canvas(
        Modifier.size(width = 18.dp, height = 13.dp).semantics { contentDescription = label }
            .graphicsLayer { scaleX = pop.value; scaleY = pop.value; alpha = if (sending) breathe else 1f },
    ) {
        val sx = size.width / 20f
        val sy = size.height / 14f
        fun stroke(points: List<Pair<Float, Float>>, progress: Float) {
            if (progress <= 0f) return
            val full = Path().apply {
                moveTo(points[0].first * sx, points[0].second * sy)
                points.drop(1).forEach { (x, y) -> lineTo(x * sx, y * sy) }
            }
            val measure = PathMeasure().apply { setPath(full, false) }
            val part = Path()
            measure.getSegment(0f, measure.length * progress.coerceIn(0f, 1f), part, true)
            drawPath(part, tint, style = Stroke(width = 1.9.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        stroke(listOf(1.5f to 7.5f, 5.5f to 11.5f, 13f to 3f), one)
        stroke(listOf(8.5f to 10.5f, 9.5f to 11.5f, 17f to 3f), two)
    }
}

@Composable
private fun TypingBubble() {
    val c = Juntos.colors
    val pulse = rememberInfiniteTransition(label = "typing")
    Row(Modifier.padding(top = 10.dp).clip(RoundedCornerShape(18.dp)).background(c.surface2).padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(3) { index ->
            val lift by pulse.animateFloat(0f, 1f, infiniteRepeatable(tween(550, delayMillis = index * 150), RepeatMode.Reverse), label = "dot$index")
            Box(Modifier.offset(y = (-4 * lift).dp).size(6.dp).alpha(0.5f + 0.5f * lift).clip(CircleShape).background(c.textMuted))
        }
    }
}

@Composable
private fun Composer(draft: String, onDraft: (String) -> Unit, onSend: () -> Unit) {
    val c = Juntos.colors
    Column {
        Box(Modifier.fillMaxWidth().height(1.dp).background(c.line))
        Row(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(10.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Box(Modifier.weight(1f).heightIn(min = 44.dp).clip(RoundedCornerShape(22.dp)).background(c.surface2).padding(horizontal = 16.dp, vertical = 11.dp)) {
                if (draft.isEmpty()) Text("Mensagem", color = c.textFaint, fontSize = JuntosTextSize.base)
                BasicTextField(
                    value = draft,
                    onValueChange = { if (it.length <= 4000) onDraft(it) },
                    textStyle = TextStyle(color = c.text, fontSize = JuntosTextSize.base),
                    cursorBrush = SolidColor(c.brand),
                    maxLines = 6,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Mensagem" },
                )
            }
            AnimatedVisibility(visible = draft.isNotBlank(), enter = scaleIn(pop(), initialScale = 0.5f) + fadeIn(pop()), exit = scaleOut(settle(), targetScale = 0.5f) + fadeOut(settle())) {
                val interaction = remember { MutableInteractionSource() }
                Box(
                    Modifier.pressScale(interaction, 0.92f).size(44.dp).clip(CircleShape).background(c.brand)
                        .clickable(interaction, indication = null, role = Role.Button, onClick = onSend)
                        .semantics { contentDescription = "Enviar" },
                    contentAlignment = Alignment.Center,
                ) { Icon(Icons.Rounded.ArrowUpward, contentDescription = null, tint = c.onBrand, modifier = Modifier.size(22.dp)) }
            }
        }
    }
}
