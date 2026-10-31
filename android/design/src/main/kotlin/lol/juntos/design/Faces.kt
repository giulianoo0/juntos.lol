package lol.juntos.design

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.times

/** web/src/ui/hue.ts: the 1..8 hue a person keeps for as long as they keep their id. */
fun hueOf(id: String): Int {
    var hash = 2166136261L.toInt()
    for (ch in id) {
        hash = hash xor ch.code
        hash *= 16777619
    }
    hash = hash xor (hash ushr 16)
    hash *= 0x85ebca6b.toInt()
    hash = hash xor (hash ushr 13)
    return ((hash.toLong() and 0xFFFFFFFFL) % 8).toInt() + 1
}

fun initialOf(name: String): String {
    val trimmed = name.trim()
    if (trimmed.isEmpty()) return "?"
    val end = trimmed.offsetByCodePoints(0, 1)
    return trimmed.substring(0, end).uppercase()
}

val MascotKinds: List<String> = MASCOT_ART.keys.toList()

/** web/src/mascot/types.ts MASCOT_ACCESSORIES, in the site's order; "none" wears nothing. */
val MascotAccessories: List<String> = listOf(
    "bowtie", "headphones", "cat-headphones", "sunglasses", "round-glasses", "beanie",
    "cap", "crown", "bow", "flower", "scarf", "space-helmet", "none",
)

/** A mascot the app can draw: the kind and what it wears. The site's colours are not drawn here. */
data class Mascot(val kind: String, val accessory: String) {
    /** web/src/mascot/avatar.ts serializeAvatar without a colour: `fox.bowtie`, or `owl` with nothing on. */
    val avatar: String get() = if (accessory == "none") kind else "$kind.$accessory"
}

/**
 * The mascot in a serialized avatar (`fox.bowtie`, `cat-preto.beanie`, `owl`); null when the
 * app has no art for its kind. An accessory newer than the app is left off rather than the face.
 */
fun mascotOf(avatar: String?): Mascot? {
    val kind = avatar?.substringBefore('.')?.substringBefore('-')?.takeIf { it in MASCOT_ART } ?: return null
    val accessory = avatar.substringAfter('.', "none").takeIf { it in MascotAccessories } ?: "none"
    return Mascot(kind, accessory)
}

fun mascotKindOf(avatar: String?): String? = mascotOf(avatar)?.kind

@Composable
fun MascotImage(mascot: Mascot, size: Dp, modifier: Modifier = Modifier) {
    val art = MASCOT_ART.getValue(mascot.kind)[MascotAccessories.indexOf(mascot.accessory)]
    Image(painterResource(art), contentDescription = null, modifier = modifier.size(size))
}

/**
 * A person's face without a camera: their mascot, drawn from the site's art, or
 * their initial on their hue when they have none.
 */
@Composable
fun Avatar(id: String, name: String, avatar: String?, size: Dp, modifier: Modifier = Modifier) {
    val mascot = mascotOf(avatar)
    if (mascot != null) {
        MascotImage(mascot, size, modifier)
        return
    }
    val colors = Juntos.colors
    val hue = hueOf(id) - 1
    Box(
        modifier.size(size).clip(CircleShape).background(colors.hueBg.getOrElse(hue) { colors.surface3 }),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            initialOf(name),
            color = colors.hueInk.getOrElse(hue) { colors.text },
            fontWeight = FontWeight.SemiBold,
            fontSize = JuntosTextSize.base * (size / 32.dp),
        )
    }
}
