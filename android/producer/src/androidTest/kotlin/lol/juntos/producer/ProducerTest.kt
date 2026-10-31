package lol.juntos.producer

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProducerTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val producer = Producer(context, "https://juntos.lol")

    @Test
    fun a_youtube_video_resolves_and_its_cache_starts_filling() = runBlocking {
        val url = "https://www.youtube.com/watch?v=jNQXAC9IVRw"
        val summary = producer.call("youtube_resolve", mapOf("url" to url)).jsonObject
        assertEquals("jNQXAC9IVRw", summary["videoId"]!!.jsonPrimitive.content)
        val meta = producer.call(
            "local_prepare",
            mapOf("source" to mapOf("kind" to "youtube", "url" to url, "videoId" to "jNQXAC9IVRw", "title" to "Me at the zoo")),
        ).jsonObject
        val key = meta["key"]!!.jsonPrimitive.content
        var produced = 0L
        repeat(60) {
            if (produced > 0) return@repeat
            val regions = producer.call("local_regions", mapOf("key" to key)).jsonArray
            produced = regions.maxOfOrNull { it.jsonObject["producedMs"]!!.jsonPrimitive.long } ?: 0
            delay(1_000)
        }
        assertTrue("no region produced", produced > 0)
    }
}
