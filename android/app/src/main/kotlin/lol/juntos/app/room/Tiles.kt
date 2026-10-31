package lol.juntos.app.room

import lol.juntos.core.model.Member

/**
 * The order of the gallery, as Zoom keeps it: the viewer's pin, then whoever has the
 * camera on, then the rest in the order they came in.
 */
fun galleryOrder(members: List<Member>, pinned: String?): List<Member> {
    val pin = members.firstOrNull { it.id == pinned }
    val rest = members.filter { it !== pin }.sortedByDescending { it.cam == true }
    return listOfNotNull(pin) + rest
}

/** How many whole tiles one page holds, by the window's narrow side: a phone, a tablet, a big screen. */
fun tilesPerPage(smallestWidthDp: Int): Int = when {
    smallestWidthDp < 600 -> 2
    smallestWidthDp < 840 -> 4
    else -> 6
}

data class Grid(val columns: Int, val rows: Int)

/**
 * The columns and rows that give [count] tiles the biggest 4:3 face inside a box of
 * [width] by [height]: two on an upright phone stack, two on a lying one sit side by side.
 */
fun gridFor(count: Int, width: Float, height: Float, gap: Float): Grid {
    if (count <= 1) return Grid(1, 1)
    return (1..count).map { columns -> Grid(columns, (count + columns - 1) / columns) }
        .filter { it.columns * (it.rows - 1) < count }
        .maxBy { grid ->
            val w = (width - gap * (grid.columns - 1)) / grid.columns
            val h = (height - gap * (grid.rows - 1)) / grid.rows
            minOf(w, h * 4f / 3f)
        }
}

/** Where the fold of a foldable runs, and whether it splits the screen in two. */
data class Hinge(val horizontal: Boolean, val halfOpened: Boolean, val separating: Boolean)

enum class RoomLayout {
    /** Header, the video when there is one, the gallery, the dock. */
    Column,
    /** The video takes the whole screen and the bars hide. */
    Immersive,
    /** The video beside the gallery: a tablet, an open foldable lying down, a book posture. */
    Split,
    /** A foldable half closed on a table: the video above the fold, the room below it. */
    Tabletop,
}

/** Without a video there is only the gallery, lying down or not; a tablet tells itself by its narrow side. */
fun roomLayout(widthDp: Int, heightDp: Int, smallestWidthDp: Int, hasMedia: Boolean, fullscreen: Boolean, hinge: Hinge?): RoomLayout = when {
    !hasMedia -> RoomLayout.Column
    fullscreen -> RoomLayout.Immersive
    hinge != null && hinge.horizontal && hinge.halfOpened -> RoomLayout.Tabletop
    hinge != null && !hinge.horizontal && hinge.separating -> RoomLayout.Split
    widthDp > heightDp && smallestWidthDp >= 600 -> RoomLayout.Split
    widthDp > heightDp -> RoomLayout.Immersive
    else -> RoomLayout.Column
}
