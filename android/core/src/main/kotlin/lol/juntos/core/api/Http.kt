package lol.juntos.core.api

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The one client the app talks to the site with: API, socket and media share its cookies. */
fun juntosHttpClient(cookies: CookieJar, userAgent: String): OkHttpClient = OkHttpClient.Builder()
    .cookieJar(cookies)
    .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("User-Agent", userAgent).build()) }
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()

internal class Reply(val status: Int, val body: String) {
    val ok get() = status in 200..299
}

/** The body is read on OkHttp's thread, so a caller on the main thread never touches the network. */
internal suspend fun Call.reply(): Reply = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(e)

        override fun onResponse(call: Call, response: Response) {
            runCatching { response.use { Reply(it.code, it.body?.string().orEmpty()) } }
                .fold({ continuation.resume(it) }, { continuation.resumeWithException(it) })
        }
    })
}
