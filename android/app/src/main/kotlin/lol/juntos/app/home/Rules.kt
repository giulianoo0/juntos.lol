package lol.juntos.app.home

import kotlin.random.Random

private val CODE = Regex("^[A-Z0-9]{8}$")

/** web/src/roomCode.ts: a code out of a pasted link, a scheme-less juntos.lol/room/XXXX or the bare code. */
fun roomCodeFrom(input: String): String? {
    val trimmed = input.trim()
    if (trimmed.isEmpty()) return null
    val last = trimmed.split('?', '#').first().split('/').lastOrNull { it.isNotEmpty() } ?: return null
    return last.uppercase().takeIf { CODE.matches(it) }
}

private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

/** The nickname the site gives someone who has not picked one (Room.tsx). */
fun guestName(random: Random = Random.Default): String =
    "Guest-" + (1..6).map { ALPHABET[random.nextInt(ALPHABET.length)] }.joinToString("")
