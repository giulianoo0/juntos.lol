package lol.juntos.app.room

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.animateBounds
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.movableContentOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.flow.flowOf
import lol.juntos.design.settle
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

enum class Sheet { Chat, People, Settings, Share }

/**
 * The room. Upright: header, the video in 16:9 when there is one, the gallery, the dock.
 * Lying down the video takes the screen; a tablet sets it beside the gallery and a
 * foldable on a table above the fold (see [roomLayout]). Everything comes from the
 * [AppGraph]'s session and player.
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
    val host = remember(session) { graph.producer?.let { LocalHost(it, graph.api, session, entry.roomId, scope) } }
    DisposableEffect(host) { onDispose { host?.close() } }
    FollowRoom(graph.baseUrl, session, player, host)
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
                is SyncEvent.NeedMedia -> session.state.value.seat()?.let { host?.need(it, event.generation) }
                SyncEvent.MediaIdle -> host?.idle()
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

    val config = LocalConfiguration.current
    val hosted by (host?.media ?: flowOf(null)).collectAsState(null)
    val status = state.room?.status.orEmpty()
    val hasMedia = (status.isNotEmpty() && status != "empty") || hosted != null
    LaunchedEffect(hasMedia) { if (!hasMedia) fullscreen = false }
    val fold = rememberFold()
    val layout = roomLayout(config.screenWidthDp, config.screenHeightDp, config.smallestScreenWidthDp, hasMedia, fullscreen, fold?.hinge)
    val immersive = layout == RoomLayout.Immersive
    ImmersiveBars(immersive)
    val density = LocalDensity.current

    Box(
        Modifier
            .fillMaxSize()
            .door(entry.door, 36.dp)
            .background(if (immersive) Color.Black else c.frameGround),
    ) {
        LookaheadScope {
            val corner by animateDpAsState(if (immersive) 0.dp else 18.dp, pop(), label = "stage-corner")
            val stage = remember {
                movableContentOf { modifier: Modifier, full: Boolean ->
                    Box(
                        modifier
                            .animateBounds(this@LookaheadScope, boundsTransform = BoundsSpring())
                            .clip(RoundedCornerShape(corner.coerceAtLeast(0.dp)))
                            .background(Color.Black),
                    ) {
                        PlayerSurface(player, Modifier.fillMaxSize())
                        PlayerControls(
                            player = player,
                            intents = intents,
                            fullscreen = full,
                            onFullscreenChange = { fullscreen = it },
                            onSettings = { sheet = Sheet.Settings },
                            modifier = Modifier.fillMaxSize(),
                        )
                        BurstLayer(bursts, Modifier.fillMaxSize())
                    }
                }
            }
            val header = @Composable { modifier: Modifier ->
                RoomHeader(
                    state = state,
                    roomId = entry.roomId,
                    modifier = modifier,
                    onPeople = { sheet = Sheet.People },
                    onCopied = { scope.launch { toasts.show("Link copiado") } },
                )
            }
            val gallery = @Composable { modifier: Modifier ->
                Gallery(
                    members = state.members,
                    controllerId = state.controllerId,
                    pinned = pinned,
                    onPin = { id -> pinned = if (pinned == id) null else id },
                    modifier = modifier,
                )
            }
            val dock = @Composable {
                Dock(
                    sheet = sheet,
                    onSheet = { sheet = if (sheet == it) null else it },
                    canShare = host != null && state.isController,
                    onReact = { bursts.add(it) },
                    onLeave = leave,
                )
            }
            when (layout) {
                RoomLayout.Immersive -> stage(Modifier.fillMaxSize(), true)
                RoomLayout.Column -> Column(Modifier.fillMaxSize()) {
                    header(Modifier.statusBarsPadding())
                    AnimatedVisibility(
                        visible = hasMedia,
                        enter = expandVertically(pop()) + fadeIn(pop()),
                        exit = shrinkVertically(settle()) + fadeOut(settle()),
                    ) {
                        stage(Modifier.padding(horizontal = 8.dp).fillMaxWidth().aspectRatio(16f / 9f), false)
                    }
                    gallery(Modifier.weight(1f))
                    dock()
                }
                RoomLayout.Split -> Column(Modifier.fillMaxSize()) {
                    header(Modifier.statusBarsPadding())
                    Row(Modifier.weight(1f).fillMaxWidth()) {
                        val hinge = fold?.takeIf { !it.hinge.horizontal }
                        val pane = if (hinge != null) Modifier.width(with(density) { hinge.bounds.left.toDp() }) else Modifier.weight(2f)
                        Box(pane.fillMaxHeight().padding(start = 8.dp), contentAlignment = Alignment.Center) {
                            stage(Modifier.fillMaxWidth().aspectRatio(16f / 9f), false)
                        }
                        if (hinge != null) Spacer(Modifier.width(with(density) { hinge.bounds.width().toDp() }))
                        gallery(Modifier.weight(1f).fillMaxHeight())
                    }
                    dock()
                }
                RoomLayout.Tabletop -> Column(Modifier.fillMaxSize()) {
                    val bounds = fold!!.bounds
                    Box(Modifier.fillMaxWidth().height(with(density) { bounds.top.toDp() }).background(Color.Black), contentAlignment = Alignment.Center) {
                        stage(Modifier.statusBarsPadding().fillMaxSize(), true)
                    }
                    Spacer(Modifier.height(with(density) { bounds.height().toDp() }))
                    header(Modifier)
                    gallery(Modifier.weight(1f))
                    dock()
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
        Sheet.Share -> host?.let {
            ShareSheet(it, onHost = { source ->
                val seat = session.state.value.seat() ?: error("no seat")
                it.host(seat, source)
            }, onDismiss = { sheet = null })
        }
        null -> Unit
    }
}

/** The fold of a foldable, in window pixels, as the WindowManager reports it. */
private class Fold(val hinge: Hinge, val bounds: android.graphics.Rect)

@Composable
private fun rememberFold(): Fold? {
    val activity = LocalContext.current.findActivity() ?: return null
    val layouts = remember(activity) { WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity) }
    val info by layouts.collectAsState(null)
    val feature = info?.displayFeatures?.filterIsInstance<FoldingFeature>()?.firstOrNull() ?: return null
    val hinge = Hinge(
        horizontal = feature.orientation == FoldingFeature.Orientation.HORIZONTAL,
        halfOpened = feature.state == FoldingFeature.State.HALF_OPENED,
        separating = feature.isSeparating,
    )
    return Fold(hinge, feature.bounds)
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

private fun lol.juntos.core.sync.SyncState.seat(): lol.juntos.core.model.Seat? {
    val id = memberId ?: return null
    val capability = capability ?: return null
    return lol.juntos.core.model.Seat(id, capability)
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
