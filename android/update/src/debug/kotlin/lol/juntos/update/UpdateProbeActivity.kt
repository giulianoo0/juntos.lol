package lol.juntos.update

import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.widget.TextView
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient

/**
 * Debug builds only: runs one update end to end from the manifest in the `manifest` extra.
 *   adb shell am start -n lol.juntos.app/lol.juntos.update.UpdateProbeActivity --es manifest http://10.0.2.2:8078/latest.json
 */
class UpdateProbeActivity : Activity() {
    private val scope = MainScope()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val label = TextView(this).apply {
            textSize = 22f
            setPadding(48, 200, 48, 48)
        }
        setContentView(label)
        val info = packageManager.getPackageInfo(packageName, 0)
        val updater = GithubUpdater(this, OkHttpClient(), intent.getStringExtra("manifest") ?: MANIFEST_URL)
        scope.launch {
            updater.state.collect {
                label.text = "Juntos ${info.versionName} (${info.longVersionCode})\n\n$it"
                Log.i(InstallResultReceiver.TAG, "v${info.longVersionCode} $it")
            }
        }
        scope.launch {
            updater.check()
            updater.install()
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }
}
