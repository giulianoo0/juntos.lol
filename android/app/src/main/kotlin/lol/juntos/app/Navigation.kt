package lol.juntos.app

import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import kotlinx.coroutines.launch
import lol.juntos.app.entry.EntryScreen
import lol.juntos.app.entry.Me
import lol.juntos.app.entry.MeStore
import lol.juntos.app.home.HomeScreen
import lol.juntos.app.room.RoomScreen
import lol.juntos.design.JuntosMotion

object Routes {
    const val HOME = "home"
    const val ENTRY = "entry/{id}"
    const val ROOM = "room/{id}"
    fun entry(id: String) = "entry/$id"
    fun room(id: String) = "room/$id"
}

/** How someone comes through a room's door: what the socket's hello needs, and what it zooms out of. */
data class RoomEntry(
    val roomId: String,
    val nickname: String,
    val avatar: String? = null,
    val ownerToken: String? = null,
    val ticket: String? = null,
    val door: String? = null,
    val roomName: String? = null,
)

/**
 * Home and room under one SharedTransitionLayout, so entering a room zooms out of the
 * button or card that opened it.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun JuntosNavHost(graph: AppGraph, linkedRoom: String?, onLinkedRoomOpened: () -> Unit) {
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()
    val entries = remember { mutableMapOf<String, RoomEntry>() }
    val store = remember(graph) { MeStore(graph.prefs) }
    var me by remember { mutableStateOf(store.load()) }
    var entering by remember { mutableStateOf(false) }

    /** To the door first: the name and face are picked there, and only then the room. */
    fun open(entry: RoomEntry) {
        entries[entry.roomId] = entry
        nav.navigate(Routes.entry(entry.roomId)) { launchSingleTop = true }
    }

    fun enter(roomId: String, nickname: String, avatar: String) {
        val entry = entries[roomId] ?: RoomEntry(roomId, nickname)
        if (entering) return
        entering = true
        scope.launch {
            try {
                me = Me(nickname, avatar).also(store::save)
                // A password ticket lasts two minutes, so it is cut on the way in, not before the door.
                val ticket = when {
                    entry.ownerToken != null -> entry.ticket
                    !graph.human.ensure() -> return@launch
                    else -> runCatching { graph.api.join(roomId) }.getOrNull()
                }
                entries[roomId] = entry.copy(nickname = nickname, avatar = avatar, ticket = ticket, door = "door-entry")
                nav.navigate(Routes.room(roomId)) { popUpTo(Routes.ENTRY) { inclusive = true } }
            } finally {
                entering = false
            }
        }
    }

    LaunchedEffect(linkedRoom) {
        if (linkedRoom != null) {
            open(RoomEntry(linkedRoom, me.nickname, me.avatar))
            onLinkedRoomOpened()
        }
    }
    SharedTransitionLayout {
        CompositionLocalProvider(LocalSharedScope provides this) {
            NavHost(
                navController = nav,
                startDestination = Routes.HOME,
                enterTransition = { fadeIn(tween(JuntosMotion.SLOW_MS)) },
                exitTransition = { fadeOut(tween(JuntosMotion.SLOW_MS)) },
                popEnterTransition = {
                    fadeIn(tween(JuntosMotion.SETTLE_MS, easing = JuntosMotion.SpringSettle)) +
                        scaleIn(tween(JuntosMotion.SETTLE_MS, easing = JuntosMotion.SpringSettle), initialScale = 0.97f)
                },
                popExitTransition = {
                    fadeOut(tween(JuntosMotion.SETTLE_MS, easing = JuntosMotion.SpringSettle)) +
                        scaleOut(tween(JuntosMotion.SETTLE_MS, easing = JuntosMotion.SpringSettle), targetScale = 0.94f)
                },
            ) {
                composable(Routes.HOME) {
                    CompositionLocalProvider(LocalNavScope provides this) {
                        HomeScreen(graph = graph, nickname = me.nickname, avatar = me.avatar, onOpen = ::open)
                    }
                }
                composable(Routes.ENTRY) { back ->
                    val id = back.arguments?.getString("id").orEmpty()
                    val entry = entries[id] ?: RoomEntry(id, me.nickname, me.avatar)
                    val roomName by produceState(entry.roomName) {
                        if (value == null) value = runCatching { graph.api.preview(id).name }.getOrNull()?.takeIf { it.isNotBlank() }
                    }
                    CompositionLocalProvider(LocalNavScope provides this) {
                        EntryScreen(
                            roomName = roomName,
                            me = me,
                            busy = entering,
                            door = entry.door,
                            onEnter = { nickname, avatar -> enter(id, nickname, avatar) },
                            onBack = { nav.popBackStack(Routes.HOME, inclusive = false) },
                        )
                    }
                }
                composable(Routes.ROOM) { back ->
                    val id = back.arguments?.getString("id").orEmpty()
                    val entry = entries[id] ?: RoomEntry(id, me.nickname, me.avatar)
                    CompositionLocalProvider(LocalNavScope provides this) {
                        RoomScreen(graph = graph, entry = entry, onLeave = { nav.popBackStack(Routes.HOME, inclusive = false) })
                    }
                }
            }
        }
    }
}
