package lol.juntos.app.room

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.res.Configuration
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.animateBounds
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.LookaheadScope
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import kotlinx.coroutines.launch
import lol.juntos.app.AppGraph
import lol.juntos.app.RoomEntry
import lol.juntos.app.door
import lol.juntos.core.sync.SessionRequest
import lol.juntos.core.sync.SyncEvent
import lol.juntos.design.BoundsSpring
import lol.juntos.design.Juntos
import lol.juntos.design.ToastHost
import lol.juntos.design.pop
import lol.juntos.design.rememberToastState
import lol.juntos.player.PlayerControls
import lol.juntos.player.PlayerIntents
import lol.juntos.player.PlayerSurface

enum class Sheet { Chat, People, Settings }

/**
 * The room on a phone. Upright: header, the video in 16:9, the people, the dock. Lying
 * down (or full screen): the same stage grows to the whole screen and the bars hide.
 * Everything comes from the [AppGraph]'s session and player.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun RoomScreen(graph: AppGraph, entry: RoomEntry, onLeave: () -> Unit) {
    val c = Juntos.colors
    val scope = rememberCoroutineScope()
    var ticket by remember { mutableStateOf(entry.ticket) }
    val session = remember(ticket) {
        graph.sessions.open(SessionRequest(entry.roomId, entry.nickname, ticket, entry.ownerToken, entry.avatar))
    }
    DisposableEffect(session) { onDispose { session.close() } }
    val player = remember { graph.players.create() }
    DisposableEffect(player) { onDispose { player.release() } }
    FollowRoom(graph.baseUrl, session, player)
    val raw by session.state.collectAsState()
    // Until the socket echoes it, this viewer wears the avatar they came in with.
    val state = raw.copy(members = raw.members.map { if (it.id == raw.memberId && it.avatar == null) it.copy(avatar = entry.avatar) else it })
    val toasts = rememberToastState()
    var sheet by remember { mutableStateOf<Sheet?>(null) }
    var pinned by remember { mutableStateOf<String?>(null) }
    var fullscreen by remember { mutableStateOf(false) }
    val bursts = remember { Bursts() }

    val leave = {
        session.leave()
        onLeave()
    }
    LaunchedEffect(session) {
        session.events.collect { event ->
            when (event) {
                SyncEvent.Kicked, SyncEvent.RoomGone, SyncEvent.Replaced -> onLeave()
                is SyncEvent.Error -> scope.launch { toasts.show("Algo deu errado: ${event.code}") }
            }
        }
    }
    val intents = remember(session) {
        object : PlayerIntents {
            override fun play(positionMs: Long) = session.play(positionMs)
            override fun pause(positionMs: Long) = session.pause(positionMs)
            override fun seek(positionMs: Long) = session.seek(positionMs)
        }
    }

    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
    val immersive = landscape || fullscreen
    ImmersiveBars(immersive)

    val corner by animateDpAsState(if (immersive) 0.dp else 18.dp, pop(), label = "stage-corner")
    val inset by animateDpAsState(if (immersive) 0.dp else 8.dp, pop(), label = "stage-inset")

    Box(
        Modifier
            .fillMaxSize()
            .door(entry.door, 36.dp)
            .background(if (immersive) Color.Black else c.frameGround),
    ) {
        LookaheadScope {
            Column(Modifier.fillMaxSize()) {
                AnimatedVisibility(
                    visible = !immersive,
                    enter = expandVertically(pop()) + fadeIn(),
                    exit = shrinkVertically(pop()) + fadeOut(),
                ) {
                    RoomHeader(
                        state = state,
                        modifier = Modifier.statusBarsPadding(),
                        onPeople = { sheet = Sheet.People },
                        onSettings = { sheet = Sheet.Settings },
                    )
                }
                Box(
                    Modifier
                        .animateBounds(this@LookaheadScope, boundsTransform = BoundsSpring())
                        .then(if (immersive) Modifier.fillMaxSize() else Modifier.fillMaxWidth().aspectRatio(16f / 9f))
                        .padding(horizontal = inset.coerceAtLeast(0.dp))
                        .clip(RoundedCornerShape(corner.coerceAtLeast(0.dp)))
                        .background(Color.Black),
                ) {
                    PlayerSurface(player, Modifier.fillMaxSize())
                    PlayerControls(
                        player = player,
                        intents = intents,
                        fullscreen = immersive,
                        onFullscreenChange = { fullscreen = it },
                        modifier = Modifier.fillMaxSize(),
                    )
                    BurstLayer(bursts, Modifier.fillMaxSize())
                }
                AnimatedVisibility(
                    visible = !immersive,
                    modifier = Modifier.weight(1f),
                    enter = slideInVertically(pop()) { it / 3 } + fadeIn(),
                    exit = slideOutVertically(pop()) { it / 3 } + fadeOut(),
                ) {
                    Column(Modifier.fillMaxSize()) {
                        PeopleGrid(
                            members = state.members,
                            controllerId = state.controllerId,
                            pinned = pinned,
                            onPin = { id -> pinned = if (pinned == id) null else id },
                            modifier = Modifier.weight(1f),
                        )
                        Dock(
                            roomId = entry.roomId,
                            sheet = sheet,
                            onSheet = { sheet = if (sheet == it) null else it },
                            onReact = { bursts.add(it) },
                            onCopied = { scope.launch { toasts.show("Link copiado") } },
                            onLeave = leave,
                        )
                    }
                }
            }
        }
        DoorOverlay(
            door = state.door,
            onPassword = { password ->
                scope.launch {
                    runCatching { graph.api.join(entry.roomId, password) }
                        .onSuccess { ticket = it }
                        .onFailure { toasts.show("Senha errada") }
                }
            },
            onLeave = leave,
        )
        ToastHost(toasts, Modifier.align(androidx.compose.ui.Alignment.BottomCenter).padding(bottom = 72.dp))
    }

    when (sheet) {
        Sheet.Chat -> ChatSheet(state.chat, state.members, onSend = session::chat, onDismiss = { sheet = null })
        Sheet.People -> PeopleSheet(state.members, state.memberId, state.controllerId, pinned, onPin = { pinned = if (pinned == it) null else it }, onDismiss = { sheet = null })
        Sheet.Settings -> SettingsSheet(player, onDismiss = { sheet = null })
        null -> Unit
    }
}

/** Lying down the video takes the screen: the system bars hide and come back with a swipe. */
@Composable
private fun ImmersiveBars(immersive: Boolean) {
    val view = LocalView.current
    val window = view.context.findActivity()?.window ?: return
    DisposableEffect(immersive) {
        val controller = WindowCompat.getInsetsController(window, view)
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (immersive) controller.hide(WindowInsetsCompat.Type.systemBars()) else controller.show(WindowInsetsCompat.Type.systemBars())
        onDispose { controller.show(WindowInsetsCompat.Type.systemBars()) }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
