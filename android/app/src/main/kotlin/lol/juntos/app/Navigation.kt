package lol.juntos.app

import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import lol.juntos.app.home.HomeScreen
import lol.juntos.app.home.guestName
import lol.juntos.app.room.RoomScreen
import lol.juntos.design.JuntosMotion
import lol.juntos.design.MascotKinds

object Routes {
    const val HOME = "home"
    const val ROOM = "room/{id}"
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
)

/**
 * Home and room under one SharedTransitionLayout, so entering a room zooms out of the
 * button or card that opened it.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun JuntosNavHost(graph: AppGraph, linkedRoom: String?, onLinkedRoomOpened: () -> Unit) {
    val nav = rememberNavController()
    val entries = remember { mutableMapOf<String, RoomEntry>() }
    val me = remember { guestName() to "${MascotKinds.random()}.bowtie" }
    fun open(entry: RoomEntry) {
        entries[entry.roomId] = entry
        nav.navigate(Routes.room(entry.roomId)) { launchSingleTop = true }
    }
    LaunchedEffect(linkedRoom) {
        if (linkedRoom != null) {
            open(RoomEntry(linkedRoom, me.first, me.second))
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
            ) {
                composable(Routes.HOME) {
                    CompositionLocalProvider(LocalNavScope provides this) {
                        HomeScreen(graph = graph, nickname = me.first, avatar = me.second, onOpen = ::open)
                    }
                }
                composable(Routes.ROOM) { back ->
                    val id = back.arguments?.getString("id").orEmpty()
                    val entry = entries[id] ?: RoomEntry(id, me.first, me.second)
                    CompositionLocalProvider(LocalNavScope provides this) {
                        RoomScreen(graph = graph, entry = entry, onLeave = { nav.popBackStack(Routes.HOME, inclusive = false) })
                    }
                }
            }
        }
    }
}
