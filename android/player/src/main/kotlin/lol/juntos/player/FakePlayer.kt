package lol.juntos.player

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/** A player without media, for screens built before :player lands. */
class FakePlayer(durationMs: Long = 596_000) : JuntosPlayer {
    private val _snapshot = MutableStateFlow(
        PlayerSnapshot(
            durationMs = durationMs,
            audio = listOf(TrackOption(0, "Inglês", "en", selected = true), TrackOption(1, "Português", "pt")),
            subtitles = listOf(TrackOption(0, "Português", "pt")),
        ),
    )
    override val snapshot: StateFlow<PlayerSnapshot> = _snapshot

    override val positionMs get() = _snapshot.value.positionMs
    override val playing get() = _snapshot.value.playing
    override val buffering get() = _snapshot.value.buffering

    override fun seekTo(positionMs: Long) = _snapshot.update { it.copy(positionMs = positionMs) }
    override fun play() = _snapshot.update { it.copy(playing = true) }
    override fun pause() = _snapshot.update { it.copy(playing = false) }
    override fun setRate(rate: Float) {}
    override fun load(source: MediaSource, startAtMs: Long) = _snapshot.update { it.copy(positionMs = startAtMs) }
    override fun selectAudio(index: Int) = _snapshot.update { s -> s.copy(audio = s.audio.map { it.copy(selected = it.index == index) }) }
    override fun selectSubtitle(index: Int?) = _snapshot.update { s -> s.copy(subtitles = s.subtitles.map { it.copy(selected = it.index == index) }) }
    override fun setSidecarSubtitles(subtitles: List<SidecarSubtitle>) = _snapshot.update { s ->
        s.copy(subtitles = subtitles.mapIndexed { i, sub -> TrackOption(i, sub.label, sub.language) } + s.subtitles.filter { it.index >= 1000 })
    }
    override fun setSubtitleDelay(ms: Long) = _snapshot.update { it.copy(subtitleDelayMs = ms.coerceIn(-600_000, 600_000)) }
    override fun importSubtitle(name: String, text: String): Int? {
        if (!text.contains("-->") && !text.contains("Dialogue:")) return null
        val index = 1000 + _snapshot.value.subtitles.count { it.index >= 1000 }
        _snapshot.update { s -> s.copy(subtitles = s.subtitles.map { it.copy(selected = false) } + TrackOption(index, name, selected = true)) }
        return index
    }
    override fun selectQuality(index: Int?) = _snapshot.update { s -> s.copy(qualities = s.qualities.map { it.copy(selected = it.index == index) }) }
    override fun release() {}
}
