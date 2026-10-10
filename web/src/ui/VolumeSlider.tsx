import { Zap } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { Translator } from '../i18n/useT'

/** The loudest a slider goes: past 1 the sound is boosted by a gain node. */
export const MAX_LEVEL = 2

// Near enough to 100% to land on it, so the boost line is easy to come back to.
const SNAP = 0.04

export function snapLevel(level: number, max = MAX_LEVEL): number {
  const next = Math.min(Math.max(level, 0), max)
  return Math.abs(next - 1) < SNAP ? 1 : next
}

/**
 * A vertical slider from 0 to `max`: up to 100% is the plain volume, past it
 * the boost, with a line at 100% between them. A native range sits
 * transparent on top so dragging, keys and focus stay the browser's.
 */
export function VolumeSlider({ level, max = MAX_LEVEL, onLevel, t }: {
  level: number
  max?: number
  onLevel: (level: number) => void
  t: Translator
}) {
  const boostable = max > 1
  const percent = Math.round(level * 100)
  const boosted = level > 1
  return (
    <div className={`volume-slider ${boostable ? 'can-boost' : ''} ${boosted ? 'is-boosted' : ''}`}>
      <span className="volume-readout">{boosted ? <Zap size={10} aria-hidden="true" /> : null}{percent}%</span>
      <div
        className="volume-track"
        style={{
          '--level': `${(Math.min(level, max) / max) * 100}%`,
          '--base': `${(Math.min(level, 1) / max) * 100}%`,
        } as CSSProperties}
        onDoubleClick={() => onLevel(1)}
      >
        <span className="volume-fill" />
        {boosted ? <span className="volume-fill is-boost" /> : null}
        {boostable ? <span className="volume-boost-zone" title={t('room.volumeBoost')} /> : null}
        {boostable ? <span className="volume-divider" /> : null}
        <span className="volume-thumb" />
        <input
          className="volume-range"
          aria-label={t('room.volume')}
          aria-valuetext={`${percent}%`}
          type="range"
          min="0"
          max={max}
          step="0.01"
          value={Math.min(level, max)}
          onChange={(event) => onLevel(snapLevel(Number(event.target.value), max))}
        />
      </div>
    </div>
  )
}
