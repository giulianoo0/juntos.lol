package lol.juntos.player

import android.media.audiofx.DynamicsProcessing
import android.util.Log

/**
 * Áudio estável, as the site's: one compressor over the whole band pulls the
 * explosions down, its gain brings the voices back up, and a limiter catches
 * what would clip. Films mixed for a cinema (a 5.1 mix folded to two speakers)
 * leave the dialogue far below the effects.
 */
internal class SteadyAudio {
    private var effect: DynamicsProcessing? = null
    private var session = 0

    val on get() = effect != null

    /** Whether it is on for [audioSession]: an effect the device refuses leaves the sound as it was. */
    fun set(audioSession: Int, on: Boolean): Boolean {
        if (!on || audioSession != session) release()
        if (!on || audioSession == 0) return false
        if (effect != null) return true
        effect = runCatching {
            val config = DynamicsProcessing.Config.Builder(
                DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION, 2,
                false, 0, true, 1, false, 0, true,
            ).build()
            DynamicsProcessing(0, audioSession, config).apply {
                setMbcBandAllChannelsTo(0, DynamicsProcessing.MbcBand(true, 20_000f, 5f, 300f, 6f, -30f, 12f, -90f, 1f, 0f, MAKEUP_DB))
                setLimiterAllChannelsTo(DynamicsProcessing.Limiter(true, true, 0, 3f, 250f, 20f, -1f, 0f))
                enabled = true
            }
        }.onFailure { Log.w("SteadyAudio", "no dynamics processing on this device", it) }.getOrNull()
        session = audioSession
        return effect != null
    }

    fun release() {
        effect?.release()
        effect = null
    }

    private companion object {
        const val MAKEUP_DB = 9f
    }
}
