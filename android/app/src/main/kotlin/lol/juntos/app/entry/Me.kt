package lol.juntos.app.entry

import kotlin.random.Random
import lol.juntos.app.home.guestName
import lol.juntos.design.MascotKinds
import lol.juntos.design.mascotOf

/** internal/sync/hub.go maxWSNicknameBytes, the same 64 the API takes on a new room. */
const val MAX_NICKNAME_BYTES = 64

/** Who this phone goes into rooms as. */
data class Me(val nickname: String, val avatar: String)

/** internal/sync/hub.go validNickname: something besides spaces, no control characters, 64 bytes of UTF-8 at most. */
fun validNickname(value: String): Boolean =
    value.isNotBlank() && value.encodeToByteArray().size <= MAX_NICKNAME_BYTES && value.none { it.isISOControl() }

/** What the name field keeps of what was typed or pasted: no control characters, never past 64 bytes or through a character. */
fun fitNickname(typed: String): String {
    val clean = typed.filterNot { it.isISOControl() }
    var bytes = 0
    var end = 0
    while (end < clean.length) {
        val next = clean.offsetByCodePoints(end, 1)
        bytes += clean.substring(end, next).encodeToByteArray().size
        if (bytes > MAX_NICKNAME_BYTES) break
        end = next
    }
    return clean.substring(0, end)
}

/** The name a room gets: the typed one trimmed, or a guest name for none, as the site's door does. */
fun nicknameToEnter(typed: String, random: Random = Random.Default): String =
    fitNickname(typed).trim().ifEmpty { guestName(random) }

/** The app's preferences, as plain strings. */
interface Prefs {
    fun get(key: String): String?
    fun put(key: String, value: String)
}

class MemoryPrefs : Prefs {
    private val values = mutableMapOf<String, String>()
    override fun get(key: String): String? = values[key]
    override fun put(key: String, value: String) { values[key] = value }
}

/** The name and face picked at the door, kept for the next room; a first run gets a random pair. */
class MeStore(private val prefs: Prefs, private val random: Random = Random.Default) {
    fun load(): Me = Me(
        nickname = prefs.get(NICKNAME)?.takeIf(::validNickname) ?: guestName(random),
        avatar = prefs.get(AVATAR)?.takeIf { mascotOf(it)?.avatar == it } ?: "${MascotKinds.random(random)}.bowtie",
    )

    fun save(me: Me) {
        prefs.put(NICKNAME, me.nickname)
        prefs.put(AVATAR, me.avatar)
    }

    private companion object {
        const val NICKNAME = "me.nickname"
        const val AVATAR = "me.avatar"
    }
}
