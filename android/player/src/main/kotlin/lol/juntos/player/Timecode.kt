package lol.juntos.player

/** The clock under the bar, as the site's Timecode: minutes run past sixty. */
fun timecode(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    return "${total / 60}:${(total % 60).toString().padStart(2, '0')}"
}
