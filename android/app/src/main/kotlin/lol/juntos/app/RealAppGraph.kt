package lol.juntos.app

import android.content.Context
import java.util.UUID
import lol.juntos.app.human.WebHumanGate
import lol.juntos.core.api.CookieStorage
import lol.juntos.core.api.HttpJuntosApi
import lol.juntos.core.api.JuntosApi
import lol.juntos.core.api.PersistentCookieJar
import lol.juntos.core.api.juntosHttpClient
import lol.juntos.core.human.HumanGate
import lol.juntos.core.human.TurnstileGate
import lol.juntos.core.sync.SocketSyncSessionFactory
import lol.juntos.core.sync.SyncSessionFactory
import lol.juntos.player.Media3Player
import lol.juntos.player.PlayerFactory
import lol.juntos.update.GithubUpdater
import lol.juntos.update.Updater

/** The app's preferences hold the jar, so `ss_human` and the room seats outlive the process. */
private class PreferencesCookieStorage(context: Context) : CookieStorage {
    private val preferences = context.getSharedPreferences("juntos", Context.MODE_PRIVATE)
    override fun read(): String? = preferences.getString("cookies", null)
    override fun write(value: String) = preferences.edit().putString("cookies", value).apply()
}

/** One per install: a second socket from this phone takes the seat over instead of doubling it. */
private fun installId(context: Context): String {
    val preferences = context.getSharedPreferences("juntos", Context.MODE_PRIVATE)
    return preferences.getString("device", null) ?: UUID.randomUUID().toString().also { preferences.edit().putString("device", it).apply() }
}

/** The pieces the screens talk to, for real: one OkHttp client (and its cookies) for the API, the socket and the media. */
class RealAppGraph(context: Context, override val baseUrl: String = BuildConfig.BASE_URL) : AppGraph {
    private val app = context.applicationContext
    private val cookies = PersistentCookieJar(PreferencesCookieStorage(app))
    // "Android" in the agent is what the server's telemetry counts the phone by.
    private val client = juntosHttpClient(cookies, "${System.getProperty("http.agent") ?: "Android"} $appUserAgentSuffix")
    private val device = installId(app)

    override val api: JuntosApi = HttpJuntosApi(baseUrl, client)

    /** The Turnstile widget [MainActivity] shows while a check waits on it. */
    val turnstile = WebHumanGate(api) { api.config().turnstileSiteKey }
    override val human: HumanGate = TurnstileGate(api, cookies, baseUrl) { siteKey -> turnstile.token(siteKey) }

    private val sockets = SocketSyncSessionFactory(baseUrl, client, api, human)
    override val sessions = SyncSessionFactory { request -> sockets.open(request.copy(device = request.device ?: device)) }
    override val players = PlayerFactory { Media3Player(app, client) }
    override val updater: Updater = GithubUpdater(app, client)
}
