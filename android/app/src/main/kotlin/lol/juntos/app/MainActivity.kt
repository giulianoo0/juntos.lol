package lol.juntos.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import lol.juntos.design.JuntosTheme

class MainActivity : ComponentActivity() {
    private val openRoom = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        openRoom.value = roomIdFrom(intent?.data)
        val graph = (application as JuntosApplication).graph
        setContent {
            JuntosTheme {
                JuntosNavHost(graph = graph, linkedRoom = openRoom.value, onLinkedRoomOpened = { openRoom.value = null })
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        roomIdFrom(intent.data)?.let { openRoom.value = it }
    }
}
