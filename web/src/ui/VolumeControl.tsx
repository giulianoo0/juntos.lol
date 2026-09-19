import { Volume1, Volume2, VolumeX } from 'lucide-react'
import type { CSSProperties } from 'react'
import type { Translator } from '../i18n/useT'

/**
 * A speaker that mutes on click and a slider beside it, for the players that
 * paint on a canvas. A stream that carries no sound gets a plain note instead,
 * so nobody hunts for a volume that is not there.
 */
export function VolumeControl({ volume, muted, onVolume, onMuted, t, silent, className = '' }: {
  volume: number
  muted: boolean
  onVolume: (volume: number) => void
  onMuted: (muted: boolean) => void
  t: Translator
  /** Shown in place of the controls when the stream has no sound at all. */
  silent?: { label: string; hint: string }
  className?: string
}) {
  if (silent) {
    return (
      <span className={`stage-volume is-silent ${className}`.trim()} title={silent.hint}>
        <VolumeX size={16} aria-hidden="true" />{silent.label}
      </span>
    )
  }
  const shown = muted ? 0 : volume
  const label = t(muted ? 'room.unmute' : 'room.mute')
  return (
    <div className={`stage-volume ${className}`.trim()} style={{ '--volume-fill': `${Math.round(shown * 100)}%` } as CSSProperties}>
      <button
        type="button"
        className="stage-volume-button"
        aria-label={label}
        title={label}
        aria-pressed={muted}
        // Unmuting a slider left at zero would stay silent.
        onClick={() => { if (muted && volume === 0) onVolume(1); onMuted(!muted) }}
      >
        {shown === 0 ? <VolumeX size={16} /> : shown < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
      </button>
      <input
        className="stage-volume-range"
        type="range"
        min="0"
        max="1"
        step="0.01"
        aria-label={t('room.volume')}
        value={shown}
        onChange={(event) => {
          const next = Number(event.target.value)
          onVolume(next)
          if (muted !== (next === 0)) onMuted(next === 0)
        }}
      />
    </div>
  )
}
