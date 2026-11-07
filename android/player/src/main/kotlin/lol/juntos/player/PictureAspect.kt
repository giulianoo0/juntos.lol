package lol.juntos.player

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** How the picture fills the player, as the site's Proporção: as made, cropped to fill, stretched, or forced to a ratio. */
enum class PictureAspect(val label: String, val ratio: Float? = null) {
    Original("Original"),
    Fill("Preencher"),
    Stretch("Esticar"),
    Wide("16:9", 16f / 9f),
    Classic("4:3", 4f / 3f),
    Cinema("21:9", 21f / 9f),
}

/** This phone's choice, the same in every room, kept with the app's preferences. */
object PictureAspects {
    private const val KEY = "aspect"
    private val chosen = MutableStateFlow(PictureAspect.Original)
    val current: StateFlow<PictureAspect> = chosen

    fun load(context: Context) {
        val saved = context.getSharedPreferences("juntos", Context.MODE_PRIVATE).getString(KEY, null)
        chosen.value = PictureAspect.entries.firstOrNull { it.name == saved } ?: PictureAspect.Original
    }

    fun choose(context: Context, aspect: PictureAspect) {
        chosen.value = aspect
        context.getSharedPreferences("juntos", Context.MODE_PRIVATE).edit().putString(KEY, aspect.name).apply()
    }
}

/** The frame the picture is drawn in, inside a [boxWidth]×[boxHeight] box, for a picture of [videoAspect]. */
internal fun pictureFrame(aspect: PictureAspect, boxWidth: Float, boxHeight: Float, videoAspect: Float): Pair<Float, Float> {
    fun fit(ratio: Float) = if (boxWidth / boxHeight > ratio) boxHeight * ratio to boxHeight else boxWidth to boxWidth / ratio
    return when (aspect) {
        PictureAspect.Original -> fit(videoAspect)
        PictureAspect.Stretch -> boxWidth to boxHeight
        PictureAspect.Fill -> if (boxWidth / boxHeight > videoAspect) boxWidth to boxWidth / videoAspect else boxHeight * videoAspect to boxHeight
        else -> fit(aspect.ratio ?: videoAspect)
    }
}
