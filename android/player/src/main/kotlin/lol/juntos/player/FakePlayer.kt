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
    override fun selectQuality(index: Int?) = _snapshot.update { s -> s.copy(qualities = s.qualities.map { it.copy(selected = it.index == index) }) }
    override fun release() {}
}
