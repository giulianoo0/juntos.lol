package lol.juntos.app.account

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import lol.juntos.app.BuildConfig
import lol.juntos.app.human.withAppSuffix
import lol.juntos.core.account.ACCOUNT_COOKIE
import lol.juntos.core.account.sessionFrom
import lol.juntos.design.IconPill
import lol.juntos.design.Juntos
import lol.juntos.design.JuntosIcons
import lol.juntos.design.JuntosTextSize

/** Where the site's callback sends the WebView once `ss_account` is set: never loaded, only caught. */
internal const val SIGNED_IN_PATH = "/app/signed-in"

/** The site's own Discord sign-in, in a WebView: [onSession] gets the `ss_account` it leaves. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun DiscordLogin(onSession: (String) -> Unit, onClose: () -> Unit, baseUrl: String = BuildConfig.BASE_URL) {
    val c = Juntos.colors
    val session by rememberUpdatedState(onSession)
    val base = remember(baseUrl) { Uri.parse(baseUrl) }
    val view = remember { arrayOfNulls<WebView>(1) }
    DisposableEffect(Unit) { onDispose { view[0]?.destroy() } }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(c.frameGround).systemBarsPadding()) {
            Row(
                Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Entrar com Discord", color = c.text, fontSize = JuntosTextSize.lg, fontWeight = FontWeight.SemiBold, maxLines = 1, modifier = Modifier.weight(1f))
                IconPill("Fechar", JuntosIcons.Close, onClick = onClose, size = 36.dp)
            }
            AndroidView(modifier = Modifier.fillMaxWidth().weight(1f), factory = { context ->
                WebView(context).apply {
                    setBackgroundColor(c.frameGround.toArgb())
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.userAgentString = withAppSuffix(settings.userAgentString, BuildConfig.VERSION_NAME)
                    val cookies = CookieManager.getInstance()
                    // A session from an earlier sign-in here must not stand in for this one.
                    cookies.setCookie(baseUrl, "$ACCOUNT_COOKIE=; Max-Age=0; Path=/")
                    var done = false
                    fun back(url: Uri): Boolean {
                        if (url.host != base.host || url.path != SIGNED_IN_PATH) return false
                        if (!done) {
                            done = true
                            val token = sessionFrom(cookies.getCookie(baseUrl))
                            if (token != null) session(token) else onClose()
                        }
                        return true
                    }
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val url = request.url
                            // Discord's "open the app" links have nowhere to go from here.
                            if (url.scheme != "https" && url.scheme != "http") return true
                            return back(url)
                        }

                        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
                            if (back(Uri.parse(url))) view.stopLoading()
                        }
                    }
                    val start = base.buildUpon().path("/api/auth/discord").appendQueryParameter("next", SIGNED_IN_PATH).build()
                    loadUrl(start.toString())
                    view[0] = this
                }
            })
        }
    }
}
