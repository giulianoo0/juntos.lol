import { memo, useEffect, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { DELAY_LIMIT_MS, DELAY_STEP_MS, formatDelay, parseDelay } from './subtitleDelay'

const HOLD_DELAY_MS = 450
const HOLD_INTERVAL_MS = 120

interface DelayControlProps {
  valueMs: number
  onChange: (ms: number) => void
  t: Translator
}

/**
 * Minus, the number, plus. A click steps a quarter second; holding keeps
 * stepping; the number itself becomes a field to type an exact value into.
 */
export const DelayControl = memo(function DelayControl({ valueMs, onChange, t }: DelayControlProps) {
  const [editing, setEditing] = useState<string | null>(null)
  const valueRef = useRef(valueMs)
  valueRef.current = valueMs
  const holdRef = useRef<{ timeout: number | null; interval: number | null }>({ timeout: null, interval: null })
  const inputRef = useRef<HTMLInputElement>(null)

  // A hold accumulates on the ref, since the prop only catches up between
  // renders; the click that closes a hold is swallowed so it adds no step.
  const repeatedRef = useRef(false)

  const clamp = (ms: number) => Math.max(-DELAY_LIMIT_MS, Math.min(DELAY_LIMIT_MS, ms))
  const step = (direction: 1 | -1) => {
    valueRef.current = clamp(valueRef.current + direction * DELAY_STEP_MS)
    onChange(valueRef.current)
  }
  const click = (direction: 1 | -1) => {
    if (repeatedRef.current) {
      repeatedRef.current = false
      return
    }
    valueRef.current = valueMs
    step(direction)
  }
  const release = () => {
    const hold = holdRef.current
    if (hold.timeout !== null) window.clearTimeout(hold.timeout)
    if (hold.interval !== null) window.clearInterval(hold.interval)
    hold.timeout = null
    hold.interval = null
  }
  const hold = (direction: 1 | -1) => {
    release()
    repeatedRef.current = false
    holdRef.current.timeout = window.setTimeout(() => {
      holdRef.current.interval = window.setInterval(() => {
        repeatedRef.current = true
        step(direction)
      }, HOLD_INTERVAL_MS)
    }, HOLD_DELAY_MS)
  }
  useEffect(() => release, [])
  useEffect(() => { if (editing !== null) inputRef.current?.select() }, [editing])

  const commit = () => {
    if (editing === null) return
    const parsed = parseDelay(editing)
    setEditing(null)
    if (parsed === null) return
    valueRef.current = parsed
    onChange(parsed)
  }

  const stepper = (direction: 1 | -1, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      className="delay-step"
      aria-label={label}
      title={label}
      onClick={() => click(direction)}
      onPointerDown={(event) => { if (event.button === 0 || event.pointerType !== 'mouse') hold(direction) }}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
    >{icon}</button>
  )

  return (
    <div className="delay-control" data-testid="delay-control">
      {stepper(-1, t('room.subtitleSooner'), <Minus size={14} aria-hidden="true" />)}
      {editing === null ? (
        <button
          type="button"
          className="delay-value"
          title={t('room.subtitleDelayEdit')}
          onClick={() => setEditing((Math.abs(valueMs) / 1000).toFixed(2).replace('.', t.language === 'pt-BR' ? ',' : '.').replace(/^/, valueMs < 0 ? '-' : ''))}
        >{formatDelay(valueMs, t.language)}</button>
      ) : (
        <input
          ref={inputRef}
          className="delay-field"
          type="text"
          inputMode="decimal"
          aria-label={t('room.subtitleDelay')}
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit()
            else if (event.key === 'Escape') setEditing(null)
            event.stopPropagation()
          }}
        />
      )}
      {stepper(1, t('room.subtitleLater'), <Plus size={14} aria-hidden="true" />)}
    </div>
  )
})
