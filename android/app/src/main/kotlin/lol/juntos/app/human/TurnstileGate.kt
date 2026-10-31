package lol.juntos.app.human

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import kotlinx.coroutines.CompletableDeferred
import lol.juntos.app.BuildConfig
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.human.HumanGate
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosRadii

fun withAppSuffix(userAgent: String, version: String): String {
    val suffix = "JuntosApp/$version"
    return if (userAgent.endsWith(suffix)) userAgent else "$userAgent $suffix"
}

/** The widget alone, on a page whose origin is the site's (loadDataWithBaseURL), so Turnstile accepts it. */
fun turnstilePage(siteKey: String, dark: Boolean): String = """
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:transparent;display:grid;place-items:center}</style>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ready&render=explicit" async defer></script>
<script>
function ready() {
  turnstile.render('#gate', {
    sitekey: ${'"'}${siteKey.replace("\"", "")}${'"'},
    action: 'human',
    theme: '${if (dark) "dark" else "light"}',
    callback: function (token) { JuntosHuman.token(token) },
    'error-callback': function () { JuntosHuman.failed() },
    'timeout-callback': function () { JuntosHuman.failed() },
  })
}
</script></head><body><div id="gate"></div></body></html>
""".trimIndent()

/**
 * A [HumanGate] that asks the screen for a Turnstile token: [ensure] waits while
 * [HumanGateHost] shows the widget, then spends the token on /api/human.
 */
@Stable
class WebHumanGate(private val api: JuntosApi, private val siteKey: suspend () -> String?) : HumanGate {
    internal var pending by mutableStateOf<Pair<String, CompletableDeferred<String?>>?>(null)
    private var verified = false

    override suspend fun ensure(): Boolean {
        if (verified) return true
        val key = siteKey() ?: return true
        val token = token(key) ?: return false
        return runCatching { api.verifyHuman(token) }.isSuccess.also { verified = it }
    }

    /** The widget's token for [key], or null when the person closes it. */
    suspend fun token(key: String): String? {
        val answer = CompletableDeferred<String?>()
        pending = key to answer
        return try { answer.await() } finally { pending = null }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun HumanGateHost(gate: WebHumanGate, baseUrl: String = BuildConfig.BASE_URL) {
    val (key, answer) = gate.pending ?: return
    val dark = Juntos.colors.isDark
    Dialog(onDismissRequest = { answer.complete(null) }) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(120.dp)
                .clip(RoundedCornerShape(JuntosRadii.xl3))
                .background(Juntos.colors.surface)
                .padding(12.dp),
        ) {
            // The widget is invisible unless it needs a tap: until then the card says it is working.
            CircularProgressIndicator(Modifier.align(Alignment.Center).size(24.dp), color = Juntos.colors.textMuted, strokeWidth = 2.dp)
            AndroidView(modifier = Modifier.fillMaxSize(), factory = { context ->
                WebView(context).apply {
                    setBackgroundColor(Color.TRANSPARENT)
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.userAgentString = withAppSuffix(settings.userAgentString, BuildConfig.VERSION_NAME)
                    addJavascriptInterface(object {
                        @JavascriptInterface fun token(value: String) { answer.complete(value) }
                        @JavascriptInterface fun failed() { answer.complete(null) }
                    }, "JuntosHuman")
                    loadDataWithBaseURL("$baseUrl/", turnstilePage(key, dark), "text/html", "utf-8", null)
                }
            })
        }
    }
}
