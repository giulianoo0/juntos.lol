package lol.juntos.app

import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import lol.juntos.design.BetaBadge
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosSpacing

object Routes {
    const val HOME = "home"
    const val ROOM = "room/{id}"
    fun room(id: String) = "room/$id"
}

/**
 * Home and room under one SharedTransitionLayout, so entering a room zooms out of the
 * button or card that opened it. Onda 3 builds the screens.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun JuntosNavHost(graph: AppGraph, linkedRoom: String?, onLinkedRoomOpened: () -> Unit) {
    val nav = rememberNavController()
    LaunchedEffect(linkedRoom) {
        if (linkedRoom != null) {
            nav.navigate(Routes.room(linkedRoom))
            onLinkedRoomOpened()
        }
    }
    SharedTransitionLayout {
        NavHost(navController = nav, startDestination = Routes.HOME) {
            composable(Routes.HOME) { Placeholder("Juntos") }
            composable(Routes.ROOM) { entry -> Placeholder("Sala ${entry.arguments?.getString("id").orEmpty()}") }
        }
    }
}

@Composable
private fun Placeholder(title: String) {
    Column(
        Modifier.fillMaxSize().background(Juntos.colors.frameGround).safeDrawingPadding(),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(JuntosSpacing.s3)) {
            Text(title, color = Juntos.colors.text)
            BetaBadge()
        }
    }
}
