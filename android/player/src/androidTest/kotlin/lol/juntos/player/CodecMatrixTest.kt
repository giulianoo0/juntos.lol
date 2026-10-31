package lol.juntos.player

import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.util.Log
import org.junit.After
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/** Each clip of android/scripts/codec-clips plays for 3 s, falling back to a software decoder if needed. */
@RunWith(Parameterized::class)
class CodecMatrixTest(private val clip: String) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun clips() = listOf("h264", "hevc", "hevc10", "vp9", "av1")
    }

    private val player = newPlayer()

    @After
    fun release() = onMain { player.release() }

    /** Neither the goldfish nor the c2.android HEVC decoder of the emulator declares Main10. */
    private fun anyDecoderPlaysMain10() = MediaCodecList(MediaCodecList.ALL_CODECS).codecInfos
        .filter { !it.isEncoder && MediaFormat.MIMETYPE_VIDEO_HEVC in it.supportedTypes }
        .any { info -> info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_HEVC).profileLevels.any { it.profile == CodecProfileLevel.HEVCProfileMain10 } }

    @Test
    fun clipPlaysThreeSecondsWithoutError() {
        if (clip == "hevc10") assumeTrue("no HEVC Main10 decoder on this device", anyDecoderPlaysMain10())
        onMain {
            player.load(MediaSource("$clipsBase/$clip/master.m3u8"))
            player.play()
        }
        val started = player.awaitPlaying()
        assertNull("error on $clip", started.error)

        val after = player.snapshot.awaitFirst(3_000) { it.error != null || it.positionMs - started.positionMs >= 2_000 }
        assertNull("error on $clip", after.error)
        assertTrue("$clip moved only ${after.positionMs - started.positionMs} ms", after.positionMs - started.positionMs >= 2_000)
        assertNotNull(after.videoDecoder)
        Log.i("CodecMatrix", "api=${Build.VERSION.SDK_INT} clip=$clip codec=${after.videoCodec} decoder=${after.videoDecoder} frames=${after.decodedFrames} dropped=${after.droppedFrames}")
    }
}
