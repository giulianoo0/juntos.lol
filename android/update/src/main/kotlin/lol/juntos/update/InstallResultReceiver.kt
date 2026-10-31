package lol.juntos.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import androidx.core.content.IntentCompat
import kotlinx.coroutines.flow.MutableSharedFlow

internal data class InstallResult(val session: Int, val status: Int, val message: String?)

internal object InstallResults {
    val flow = MutableSharedFlow<InstallResult>(extraBufferCapacity = 8)
}

/**
 * Where the PackageInstaller says how a session went. Asked for confirmation (the system did not
 * grant the silent update), it opens the system's own dialog. A self-update's success lands in
 * the new version, after this process is gone.
 */
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val session = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        Log.i(TAG, "session $session status $status ${message.orEmpty()}")
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
                ?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        }
        InstallResults.flow.tryEmit(InstallResult(session, status, message))
    }

    companion object {
        const val TAG = "JuntosUpdate"
    }
}
