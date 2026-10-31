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

private val MASCOTS = mapOf(
    "wolf" to R.drawable.mascot_wolf, "cat" to R.drawable.mascot_cat, "fox" to R.drawable.mascot_fox,
    "bunny" to R.drawable.mascot_bunny, "bear" to R.drawable.mascot_bear, "frog" to R.drawable.mascot_frog,
    "penguin" to R.drawable.mascot_penguin, "owl" to R.drawable.mascot_owl, "panda" to R.drawable.mascot_panda,
    "koala" to R.drawable.mascot_koala, "axolotl" to R.drawable.mascot_axolotl, "octopus" to R.drawable.mascot_octopus,
    "bee" to R.drawable.mascot_bee, "robot" to R.drawable.mascot_robot, "alien" to R.drawable.mascot_alien,
    "ghost" to R.drawable.mascot_ghost, "mushroom" to R.drawable.mascot_mushroom, "cactus" to R.drawable.mascot_cactus,
    "strawberry" to R.drawable.mascot_strawberry, "avocado" to R.drawable.mascot_avocado, "cloud" to R.drawable.mascot_cloud,
    "drop" to R.drawable.mascot_drop, "flame" to R.drawable.mascot_flame, "planet" to R.drawable.mascot_planet,
    "slime" to R.drawable.mascot_slime, "popcorn" to R.drawable.mascot_popcorn, "onigiri" to R.drawable.mascot_onigiri,
    "dice" to R.drawable.mascot_dice,
)

val MascotKinds: List<String> = MASCOTS.keys.toList()

/** The kind in a serialized avatar (`fox.bowtie`, `cat-preto.beanie`); null when the app has no art for it. */
fun mascotKindOf(avatar: String?): String? {
    val kind = avatar?.substringBefore('.')?.substringBefore('-') ?: return null
    return kind.takeIf { it in MASCOTS }
}

/**
 * A person's face without a camera: their mascot, drawn from the site's art, or
 * their initial on their hue when they have none.
 */
@Composable
fun Avatar(id: String, name: String, avatar: String?, size: Dp, modifier: Modifier = Modifier) {
    val kind = mascotKindOf(avatar)
    if (kind != null) {
        Image(painterResource(MASCOTS.getValue(kind)), contentDescription = null, modifier = modifier.size(size))
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
