package lol.juntos.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours

/**
 * Updates from the `android` prerelease: a newer versionCode in the manifest is downloaded to the
 * cache, checked against its sha256 and committed to the PackageInstaller asking for no prompt,
 * which Android grants to an app updating itself. When it insists, its own dialog opens instead.
 */
class GithubUpdater(
    context: Context,
    private val client: OkHttpClient,
    private val manifestUrl: String = MANIFEST_URL,
) : Updater {
    private val context = context.applicationContext
    private val installed = this.context.packageManager.getPackageInfo(this.context.packageName, 0).longVersionCode
    private val _state = MutableStateFlow<UpdateState>(UpdateState.Idle)
    override val state: StateFlow<UpdateState> = _state.asStateFlow()

    override suspend fun check() {
        if (_state.value is UpdateState.Downloading || _state.value is UpdateState.Installing) return
        _state.value = UpdateState.Checking
        _state.value = attempt("manifest") {
            val release = manifest()
            if (release.versionCode > installed) UpdateState.Available(release) else UpdateState.UpToDate
        }
    }

    override suspend fun install() {
        val release = (_state.value as? UpdateState.Available)?.release ?: return
        _state.value = attempt("install") {
            val apk = download(release)
            _state.value = UpdateState.Installing(release)
            val verdict = commit(apk)
            if (verdict.status == PackageInstaller.STATUS_SUCCESS) {
                UpdateState.UpToDate
            } else {
                UpdateState.Failed("install: ${verdict.message ?: verdict.status}")
            }
        }
    }

    private suspend fun attempt(step: String, block: suspend () -> UpdateState): UpdateState = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        UpdateState.Failed("$step: ${e.message ?: e.javaClass.simpleName}")
    }

    private suspend fun manifest(): Release = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(manifestUrl).header("Cache-Control", "no-cache").build()).execute().use {
            if (!it.isSuccessful) throw IOException("HTTP ${it.code}")
            manifestJson.decodeFromString(Release.serializer(), it.body!!.string())
        }
    }

    private suspend fun download(release: Release): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "updates").apply { deleteRecursively(); mkdirs() }
        val apk = File(dir, "juntos-${release.versionCode}.apk")
        val digest = MessageDigest.getInstance("SHA-256")
        client.newCall(Request.Builder().url(release.url).build()).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            val body = response.body!!
            val total = body.contentLength()
            var done = 0L
            var shown = -1
            val buffer = ByteArray(64 * 1024)
            body.byteStream().use { input ->
                apk.outputStream().use { output ->
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        done += read
                        val percent = if (total > 0) (done * 100 / total).toInt() else 0
                        if (percent != shown) {
                            shown = percent
                            _state.value = UpdateState.Downloading(release, percent / 100f)
                        }
                    }
                }
            }
        }
        val sha256 = digest.digest().joinToString("") { "%02x".format(it) }
        if (!sha256.equals(release.sha256, ignoreCase = true)) {
            apk.delete()
            throw IOException("sha256 $sha256 is not the manifest's")
        }
        apk
    }

    /** Commits and waits for the verdict, which a self-update rarely sees: the process goes first. */
    private suspend fun commit(apk: File): InstallResult = coroutineScope {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(context.packageName)
            setSize(apk.length())
            setInstallReason(PackageManager.INSTALL_REASON_USER)
            setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        val verdict = async(start = CoroutineStart.UNDISPATCHED) {
            InstallResults.flow.first { it.session == id && it.status != PackageInstaller.STATUS_PENDING_USER_ACTION }
        }
        withContext(Dispatchers.IO) {
            installer.openSession(id).use { session ->
                session.openWrite("base.apk", 0, apk.length()).use { output ->
                    apk.inputStream().use { it.copyTo(output) }
                    session.fsync(output)
                }
                val result = Intent(context, InstallResultReceiver::class.java)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                session.commit(PendingIntent.getBroadcast(context, id, result, flags).intentSender)
            }
        }
        verdict.await()
    }

    private companion object {
        val manifestJson = Json { ignoreUnknownKeys = true }
    }
}

/** Reads the manifest now and again every [every] for as long as the caller runs: the app runs it while open. */
suspend fun Updater.keepChecking(every: Duration = 6.hours) {
    while (true) {
        check()
        delay(every)
    }
}
