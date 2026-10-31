package lol.juntos.producer

import android.content.Context
import android.system.Os
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

internal object NativeProducer {
    init {
        System.loadLibrary("juntos_producer")
    }

    @JvmStatic external fun init(
        dataDir: String,
        site: String,
        ffmpeg: String,
        ffprobe: String,
        ytdlp: String,
        ytdlpArgs: String,
        caFile: String,
    )

    @JvmStatic external fun call(method: String, args: String): String
}

class ProducerException(message: String) : Exception(message)

/**
 * The desktop app's producer on the phone: yt-dlp, FFmpeg and the torrent
 * client write the source into a local cache, and the cache goes up to the
 * room only while someone there needs it.
 */
class Producer(private val context: Context, private val site: String) {
    private val ready = Mutex()
    private var started = false

    /** Unpacks Python, yt-dlp and FFmpeg (first run only) and starts the Rust side. */
    suspend fun start() = ready.withLock {
        if (started) return@withLock
        withContext(Dispatchers.IO) {
            YoutubeDL.getInstance().init(context)
            FFmpeg.getInstance().init(context)
            val libs = context.applicationInfo.nativeLibraryDir
            val packages = File(context.noBackupFilesDir, "youtubedl-android/packages")
            val python = File(packages, "python/usr")
            val certs = File(python, "etc/tls/cert.pem").path
            // The bundled executables were built for Termux: they load their libraries from here.
            Os.setenv("LD_LIBRARY_PATH", "${python.path}/lib:${packages.path}/ffmpeg/usr/lib", true)
            Os.setenv("PYTHONHOME", python.path, true)
            Os.setenv("SSL_CERT_FILE", certs, true)
            Os.setenv("HOME", context.filesDir.path, true)
            Os.setenv("TMPDIR", context.cacheDir.path, true)
            Os.setenv("PATH", "${System.getenv("PATH")}:$libs", true)
            val ytdlp = File(context.noBackupFilesDir, "youtubedl-android/yt-dlp/yt-dlp").path
            val args = JsonArray(listOf(ytdlp, "--js-runtimes", "quickjs:$libs/libqjs.so").map(::JsonPrimitive))
            NativeProducer.init(
                dataDir = File(context.filesDir, "producer").path,
                site = site,
                ffmpeg = "$libs/libffmpeg.so",
                ffprobe = "$libs/libffprobe.so",
                ytdlp = "$libs/libpython.so",
                ytdlpArgs = args.toString(),
                caFile = certs,
            )
        }
        started = true
    }

    /** One call by the desktop command's name; the answer's `ok`, or a [ProducerException]. */
    suspend fun call(method: String, args: Map<String, Any?> = emptyMap()): JsonElement {
        start()
        val answer = withContext(Dispatchers.IO) { NativeProducer.call(method, toJson(args).toString()) }
        val parsed = Json.parseToJsonElement(answer).jsonObject
        parsed["error"]?.let { if (it !is JsonNull) throw ProducerException((it as? JsonPrimitive)?.content ?: it.toString()) }
        return parsed["ok"] ?: JsonNull
    }

    private fun toJson(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to toJson(v) })
        is List<*> -> JsonArray(value.map(::toJson))
        else -> JsonPrimitive(value.toString())
    }
}
