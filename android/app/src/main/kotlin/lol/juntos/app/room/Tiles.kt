package lol.juntos.app.room

import lol.juntos.core.model.Member

/** One person's block in the phone grid, two columns wide; [span] 2 takes the whole row. */
data class TileSlot(val member: Member, val span: Int)

/**
 * The order of the people under the stage: the viewer's pin across the whole row, then
 * whoever has the camera on, then the rest in the order they came in.
 */
fun tilesFor(members: List<Member>, pinned: String?): List<TileSlot> {
    if (members.size == 1) return listOf(TileSlot(members[0], 2))
    val pin = members.firstOrNull { it.id == pinned }
    val rest = members.filter { it !== pin }.sortedByDescending { it.cam == true }
    return listOfNotNull(pin?.let { TileSlot(it, 2) }) + rest.map { TileSlot(it, 1) }
}
