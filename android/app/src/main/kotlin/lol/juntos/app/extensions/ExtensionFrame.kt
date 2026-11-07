package lol.juntos.app.extensions

import android.annotation.SuppressLint
import android.net.Uri
import android.util.Log
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.Text
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import lol.juntos.app.BuildConfig
import lol.juntos.app.human.withAppSuffix
import lol.juntos.core.JuntosJson
import lol.juntos.core.extensions.ExtMessage
import lol.juntos.core.extensions.Installed
import lol.juntos.core.extensions.extensionOrigin
import lol.juntos.core.extensions.frameUrl
import lol.juntos.core.extensions.initMessage
import lol.juntos.core.extensions.parseMessage
import lol.juntos.design.IconPill
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosColors
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosRadii
import lol.juntos.design.JuntosTextSize

private const val BRIDGE = "juntosExtension"

private fun css(color: Color): String {
    val argb = color.toArgb()
    val a = (argb ushr 24) / 255f
    return "rgba(${(argb shr 16) and 0xff}, ${(argb shr 8) and 0xff}, ${argb and 0xff}, ${"%.3f".format(java.util.Locale.ROOT, a)})"
}

/** The site's shared tokens (web/src/extensions/theme.ts) in this app's colors. */
fun themeVars(c: JuntosColors): Map<String, String> = mapOf(
    "--text" to css(c.text),
    "--text-muted" to css(c.textMuted),
    "--text-faint" to css(c.textFaint),
    "--primary" to css(c.primaryFill),
    "--primary-hover" to css(c.primaryFill),
    "--on-primary" to css(c.onPrimary),
    "--focus" to css(c.primary),
    "--danger" to css(c.danger),
    "--frame-ground" to css(c.frameGround),
    "--frame-side" to css(c.frameGround),
    "--surface" to css(c.surface),
    "--surface-2" to css(c.surface2),
    "--surface-3" to css(c.surface3),
    "--overlay" to css(c.overlay),
    "--field" to css(c.field),
    "--line" to css(c.line),
    "--line-strong" to css(c.lineStrong),
    "--hover" to css(c.hover),
    "--hover-strong" to css(c.hoverStrong),
    "--radius-md" to "${JuntosRadii.md.value.toInt()}px",
    "--radius-lg" to "${JuntosRadii.lg.value.toInt()}px",
    "--radius-xl" to "${JuntosRadii.xl.value.toInt()}px",
    "--radius-2xl" to "${JuntosRadii.xl2.value.toInt()}px",
    "--radius-full" to "999px",
    "--ease-out" to "cubic-bezier(0.23, 1, 0.32, 1)",
    "--ease-in-out" to "cubic-bezier(0.77, 0, 0.175, 1)",
    "--duration-fast" to "150ms",
    "--duration-base" to "220ms",
)

/**
 * The page around the extension, on the site's origin (loadDataWithBaseURL) so the
 * extension's frame-ancestors lets it in. It passes the iframe's messages, from the
 * extension's own origin alone, to the app, and the app's answers back to that origin.
 */
internal fun hostPage(frame: String, origin: String, ground: String): String = """
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{margin:0;height:100%;background:$ground;overflow:hidden}iframe{position:fixed;inset:0;border:0;width:100%;height:100%;display:block}</style>
</head><body>
<iframe id="f" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" referrerpolicy="no-referrer" allow=""></iframe>
<script>
const origin = ${JuntosJson.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(origin))}
const f = document.getElementById('f')
window.addEventListener('message', (e) => {
  if (e.origin !== origin || e.source === null || e.source !== f.contentWindow) return
  try { $BRIDGE.postMessage(JSON.stringify(e.data)) } catch (_) {}
})
$BRIDGE.onmessage = (e) => { f.contentWindow && f.contentWindow.postMessage(JSON.parse(e.data), origin) }
f.src = ${JuntosJson.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(frame))}
</script></body></html>
""".trimIndent()

/**
 * One extension over the room, the screen whole, as the site's panel shows it: it talks
 * only through protocol v1, and what it plays goes to [onPlay].
 */
@SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
@Composable
fun ExtensionFrame(
    extension: Installed,
    place: Place,
    canPlay: Boolean,
    onPlay: (ExtMessage.Play) -> Unit,
    onToast: (String) -> Unit,
    onClose: () -> Unit,
    baseUrl: String = BuildConfig.BASE_URL,
) {
    val c = Juntos.colors
    val play by rememberUpdatedState(onPlay)
    val toast by rememberUpdatedState(onToast)
    val close by rememberUpdatedState(onClose)
    val init = remember(c, canPlay) {
        // The locale is the interface's, as on the site, and the app speaks Portuguese only.
        initMessage(c.isDark, themeVars(c), "pt-BR", canPlay)
    }
    val initNow by rememberUpdatedState(init)
    val origin = extensionOrigin(extension.sub, place.base, place.scheme)
    val frame = frameUrl(extension, place.base, place.scheme)
    val view = remember { arrayOfNulls<WebView>(1) }
    DisposableEffect(Unit) { onDispose { view[0]?.destroy() } }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.frameGround).systemBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(extension.manifest.name, color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.weight(1f))
                IconPill("Fechar", JuntosIcons.Close, onClick = onClose, size = 36.dp)
            }
            AndroidView(modifier = Modifier.fillMaxWidth().weight(1f), factory = { context ->
                if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
                WebView(context).apply {
                    setBackgroundColor(c.frameGround.toArgb())
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.mediaPlaybackRequiresUserGesture = true
                    settings.userAgentString = withAppSuffix(settings.userAgentString, BuildConfig.VERSION_NAME)
                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                    if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                        WebViewCompat.addWebMessageListener(this, BRIDGE, setOf(baseUrl.trimEnd('/'))) { _, message, _, isMainFrame, reply ->
                            if (!isMainFrame) return@addWebMessageListener
                            val element = runCatching { JuntosJson.parseToJsonElement(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
                            when (val said = parseMessage(element, extension.manifest)) {
                                ExtMessage.Ready -> reply.postMessage(initNow.toString())
                                ExtMessage.Close -> close()
                                is ExtMessage.Toast -> toast(said.text)
                                is ExtMessage.Play -> if (canPlay) play(said)
                                is ExtMessage.Refreshed, null -> Unit
                            }
                        }
                    } else {
                        Log.w("ExtensionFrame", "this WebView has no message listener")
                    }
                    loadDataWithBaseURL("${baseUrl.trimEnd('/')}/extensions/${Uri.encode(extension.id)}", hostPage(frame, origin, css(c.frameGround)), "text/html", "utf-8", null)
                    view[0] = this
                }
            })
        }
    }
}
