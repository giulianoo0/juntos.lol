package lol.juntos.app.room

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.core.graphics.createBitmap
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaStyleNotificationHelper
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import lol.juntos.app.MainActivity
import lol.juntos.app.R

/** The room this phone is in, as the notifications tell it. */
data class Presence(
    val roomName: String,
    val people: List<String>,
    val mediaTitle: String?,
    val playing: Boolean,
    /** This phone produces the room's video: the CPU stays up for the uploads. */
    val hosting: Boolean,
)

/** What the room screen hands the service: what to show, and what Sair and play do. */
object RoomPresence {
    private val _state = MutableStateFlow<Presence?>(null)
    val state: StateFlow<Presence?> = _state
    internal var session: MediaSession? = null
    internal var leave: (() -> Unit)? = null
    internal var togglePlay: (() -> Unit)? = null

    fun show(presence: Presence) {
        _state.value = presence
    }

    fun clear() {
        _state.value = null
        session = null
        leave = null
        togglePlay = null
    }
}

/**
 * Keeps the room alive off screen. One notification is the room itself, its people and Sair,
 * promoted to a Live Update where the system has them; the other is the video's media
 * controls, with the room's name, while there is a video.
 */
class RoomService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wake: PowerManager.WakeLock? = null
    private val logo by lazy { markBitmap(this, (64 * resources.displayMetrics.density).toInt()) }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        channels()
        scope.launch {
            RoomPresence.state.collect { presence ->
                if (presence == null) {
                    stopSelf()
                    return@collect
                }
                notifyRoom(presence)
                keepAwake(presence.hosting || presence.playing)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_LEAVE -> RoomPresence.leave?.invoke()
            ACTION_TOGGLE -> RoomPresence.togglePlay?.invoke()
            else -> {
                val presence = RoomPresence.state.value ?: Presence("Sala", emptyList(), null, playing = false, hosting = false)
                startForeground(ROOM_ID, roomNotification(presence), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        keepAwake(false)
        getSystemService(NotificationManager::class.java).cancel(MEDIA_ID)
        super.onDestroy()
    }

    private fun notifyRoom(presence: Presence) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(ROOM_ID, roomNotification(presence))
        val session = RoomPresence.session
        if (presence.mediaTitle != null && session != null) manager.notify(MEDIA_ID, mediaNotification(presence, session)) else manager.cancel(MEDIA_ID)
    }

    private fun roomNotification(presence: Presence): Notification {
        val people = peopleLine(presence.people)
        return NotificationCompat.Builder(this, ROOM_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_juntos)
            .setLargeIcon(logo)
            .setContentTitle(presence.roomName)
            .setContentText(people)
            .setStyle(NotificationCompat.BigTextStyle().bigText(listOfNotNull(presence.mediaTitle, people).joinToString("\n")))
            .setContentIntent(openRoom())
            .addAction(0, "Sair", service(ACTION_LEAVE, 1))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
            .let { if (Build.VERSION.SDK_INT >= 36) promoted(it, presence) else it }
    }

    /** Android 16 lifts it to a Live Update: the chip in the status bar counts the people. */
    @androidx.annotation.RequiresApi(36)
    private fun promoted(notification: Notification, presence: Presence): Notification =
        Notification.Builder.recoverBuilder(this, notification)
            .addExtras(android.os.Bundle().apply { putBoolean(EXTRA_REQUEST_PROMOTED_ONGOING, true) })
            .setShortCriticalText("${presence.people.size}")
            .build()

    private fun mediaNotification(presence: Presence, session: MediaSession): Notification =
        NotificationCompat.Builder(this, MEDIA_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_juntos)
            .setContentTitle(presence.mediaTitle)
            .setContentText(presence.roomName)
            .setContentIntent(openRoom())
            .addAction(
                if (presence.playing) androidx.media3.session.R.drawable.media3_icon_pause else androidx.media3.session.R.drawable.media3_icon_play,
                if (presence.playing) "Pausar" else "Reproduzir",
                service(ACTION_TOGGLE, 2),
            )
            .setStyle(MediaStyleNotificationHelper.MediaStyle(session).setShowActionsInCompactView(0))
            .setOngoing(presence.playing)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build()

    private fun keepAwake(on: Boolean) {
        val held = wake
        if (on && held == null) {
            wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "juntos:room").apply {
                setReferenceCounted(false)
                acquire()
            }
        } else if (!on && held != null) {
            held.release()
            wake = null
        }
    }

    private fun channels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(ROOM_CHANNEL, "Sala", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        manager.createNotificationChannel(NotificationChannel(MEDIA_CHANNEL, "Vídeo da sala", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
    }

    private fun openRoom(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun service(action: String, code: Int): PendingIntent =
        PendingIntent.getService(this, code, Intent(this, RoomService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE)

    companion object {
        private const val ROOM_CHANNEL = "room"
        private const val MEDIA_CHANNEL = "room-media"
        private const val ROOM_ID = 1
        private const val MEDIA_ID = 2
        private const val ACTION_LEAVE = "lol.juntos.app.room.LEAVE"
        private const val ACTION_TOGGLE = "lol.juntos.app.room.TOGGLE"
        // Notification.EXTRA_REQUEST_PROMOTED_ONGOING, past the SDK this builds against.
        private const val EXTRA_REQUEST_PROMOTED_ONGOING = "android.requestPromotedOngoing"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, RoomService::class.java))
        }
    }
}

/**
 * The j alone, filling most of the square, on [ground] or on nothing: what the notifications
 * and the media card show, instead of the launcher icon and its padding.
 */
internal fun markBitmap(context: Context, size: Int, ground: Int? = null): Bitmap {
    val mark = ContextCompat.getDrawable(context, R.drawable.ic_launcher_foreground)!!
    // The j spans y 24.1..82.8 of the icon's 108 units, centred near (54.3, 53.4).
    val unit = size * 0.8f / 58.7f
    val left = (size / 2f - 54.3f * unit).toInt()
    val top = (size / 2f - 53.4f * unit).toInt()
    return createBitmap(size, size).also { bitmap ->
        val canvas = Canvas(bitmap)
        if (ground != null) canvas.drawColor(ground)
        mark.setBounds(left, top, left + (108 * unit).toInt(), top + (108 * unit).toInt())
        mark.draw(canvas)
    }
}

/** "Você, Ana e Bia", or a count past four names. */
fun peopleLine(people: List<String>): String = when {
    people.isEmpty() || people == listOf("Você") -> "Só você"
    people.size > 4 -> "${people.size} pessoas"
    people.size == 1 -> people[0]
    else -> people.dropLast(1).joinToString(", ") + " e " + people.last()
}
