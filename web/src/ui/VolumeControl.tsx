import { Volume1, Volume2, VolumeX } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { MAX_LEVEL, VolumeSlider } from './VolumeSlider'

/**
 * A speaker with the same 0–200% slider as the player above it, for the
 * players that paint on a canvas. With a mouse the slider opens on hover and
 * the speaker mutes; on touch the speaker opens it. A stream that carries no
 * sound gets a plain note instead, so nobody hunts for a volume that is not there.
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
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

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
    <div ref={rootRef} className={`stage-volume volume-control ${open ? 'is-open' : ''} ${className}`.trim()}>
      <button
        type="button"
        className="stage-volume-button"
        aria-label={label}
        title={label}
        aria-pressed={muted}
        onClick={() => {
          if (window.matchMedia('(hover: none)').matches) {
            setOpen((value) => !value)
            return
          }
          // Unmuting a slider left at zero would stay silent.
          if (muted && volume === 0) onVolume(1)
          onMuted(!muted)
        }}
      >
        {shown === 0 ? <VolumeX size={16} /> : shown < 0.5 ? <Volume1 size={16} /> : <Volume2 size={16} />}
      </button>
      <div className="volume-panel">
        <VolumeSlider
          level={shown}
          max={MAX_LEVEL}
          onLevel={(next) => {
            onVolume(next)
            if (muted !== (next === 0)) onMuted(next === 0)
          }}
          t={t}
        />
      </div>
    </div>
  )
}
