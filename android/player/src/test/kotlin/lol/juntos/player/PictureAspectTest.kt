package lol.juntos.player

import org.junit.Assert.assertEquals
import org.junit.Test

class PictureAspectTest {
    private fun frame(aspect: PictureAspect, video: Float = 2.4f) = pictureFrame(aspect, 1600f, 900f, video)

    @Test fun originalLetterboxesTheWidePicture() = assertEquals(1600f to 1600f / 2.4f, frame(PictureAspect.Original))

    @Test fun fillCoversTheBox() = assertEquals(900f * 2.4f to 900f, frame(PictureAspect.Fill))

    @Test fun stretchTakesTheWholeBox() = assertEquals(1600f to 900f, frame(PictureAspect.Stretch))

    @Test fun aForcedRatioFitsInside() = assertEquals(1200f to 900f, frame(PictureAspect.Classic, video = 16f / 9f))
}
