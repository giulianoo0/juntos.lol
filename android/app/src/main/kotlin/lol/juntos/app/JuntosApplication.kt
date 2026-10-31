package lol.juntos.app

import android.app.Application

class JuntosApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = FakeAppGraph()
    }
}

/** `JuntosApp/<version>`: the site hides its APK button inside the app's own web views. */
val appUserAgentSuffix: String get() = "JuntosApp/${BuildConfig.VERSION_NAME}"
