package lol.juntos.update

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable

/** The prerelease of fixed tag `android`; never "latest", which the desktop links use. */
const val MANIFEST_URL = "https://github.com/giulianoo0/juntos.lol/releases/download/android/latest.json"

@Serializable
data class Release(val versionCode: Int, val versionName: String, val url: String, val sha256: String)

sealed interface UpdateState {
    data object Idle : UpdateState
    data object Checking : UpdateState
    data object UpToDate : UpdateState
    data class Available(val release: Release) : UpdateState
    data class Downloading(val release: Release, val fraction: Float) : UpdateState
    data class Installing(val release: Release) : UpdateState
    data class Failed(val reason: String) : UpdateState
}

/**
 * Reads the manifest, downloads a newer APK, checks its sha256 and hands it to the
 * PackageInstaller (no prompt when this app is the installer of record).
 */
interface Updater {
    val state: StateFlow<UpdateState>
    suspend fun check()
    suspend fun install()
}

class NoUpdater : Updater {
    override val state: StateFlow<UpdateState> = MutableStateFlow(UpdateState.UpToDate)
    override suspend fun check() {}
    override suspend fun install() {}
}
