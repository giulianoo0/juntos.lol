package lol.juntos.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.launch
import lol.juntos.app.human.HumanGateHost
import lol.juntos.design.JuntosTheme
import lol.juntos.update.keepChecking

class MainActivity : ComponentActivity() {
    private val openRoom = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        openRoom.value = roomIdFrom(intent?.data)
        val graph = (application as JuntosApplication).graph
        lifecycleScope.launch { repeatOnLifecycle(Lifecycle.State.STARTED) { graph.updater.keepChecking() } }
        setContent {
            JuntosTheme {
                JuntosNavHost(graph = graph, linkedRoom = openRoom.value, onLinkedRoomOpened = { openRoom.value = null })
                (graph as? RealAppGraph)?.let { HumanGateHost(it.turnstile, graph.baseUrl) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        roomIdFrom(intent.data)?.let { openRoom.value = it }
    }
}
