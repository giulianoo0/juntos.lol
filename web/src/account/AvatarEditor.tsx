import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useT } from '../i18n/useT'
import { KINDS, MASCOT_ACCESSORIES, MASCOT_KINDS, Mascot, serializeAvatar, type AvatarSpec } from '../mascot'
import { avatarSpec } from './AvatarFace'
import styles from './AvatarEditor.module.css'

/** How long the preview smiles after a change. */
const JOY_MS = 900

/** One row of choices: arrows move and pick, as in any radio group. */
function Choices<T extends string>({ label, options, value, onPick, className, render }: {
  label: string
  options: readonly T[]
  value: T
  onPick: (value: T) => void
  className: string
  render: (option: T, chosen: boolean) => { name: string; body: ReactNode; className?: string }
}) {
  const groupRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const index = options.indexOf(value)
    const next = options[(index + step + options.length) % options.length]!
    onPick(next)
    groupRef.current?.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus()
  }
  return (
    <div ref={groupRef} role="radiogroup" aria-label={label} className={className}>
      {options.map((option) => {
        const chosen = option === value
        const { name, body, className: itemClass } = render(option, chosen)
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={chosen}
            aria-label={name}
            title={name}
            tabIndex={chosen ? 0 : -1}
            data-value={option}
            className={itemClass}
            onClick={() => onPick(option)}
            onKeyDown={onKeyDown}
          >
            {body}
          </button>
        )
      })}
    </div>
  )
}

const DEFAULT_COLOR = 'default'
const ACCESSORIES = MASCOT_ACCESSORIES.map((accessory) => accessory.id)

/**
 * Builds an avatar: the creature, its color and what it wears, over a big
 * preview that smiles at every change. `value` is the avatar string of
 * `mascot/avatar.ts` ('' draws the default creature).
 */
export function AvatarEditor({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT()
  const spec = avatarSpec(value)
  const [joy, setJoy] = useState(false)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return undefined
    }
    setJoy(true)
    const timer = window.setTimeout(() => setJoy(false), JOY_MS)
    return () => window.clearTimeout(timer)
  }, [value])

  const change = (next: Partial<AvatarSpec>) => {
    const merged = { ...spec, ...next }
    // A color belongs to its creature: switching creatures drops one the new one lacks.
    if (merged.color && !KINDS[merged.kind].colors?.[merged.color]) delete merged.color
    onChange(serializeAvatar(merged))
  }

  const colors = [DEFAULT_COLOR, ...Object.keys(KINDS[spec.kind].colors ?? {})]
  const swatch = (color: string) => (color === DEFAULT_COLOR ? KINDS[spec.kind].body : KINDS[spec.kind].colors?.[color]?.body ?? KINDS[spec.kind].body)

  return (
    <div className={styles.editor}>
      <div className={styles.preview}>
        <span key={value} className={styles.bounce}>
          <Mascot kind={spec.kind} color={spec.color} accessory={spec.accessory} expression={joy ? 'happy' : 'idle'} size={168} />
        </span>
      </div>
      <div className={styles.pickers}>
        <Choices
          label={t('avatar.kind')}
          options={MASCOT_KINDS}
          value={spec.kind}
          onPick={(kind) => change({ kind })}
          className={styles.kinds}
          render={(kind) => ({
            name: t(`mascot.kind.${kind}`),
            className: styles.kind,
            body: <Mascot kind={kind} expression="idle" accessory="none" size={40} still />,
          })}
        />
        {colors.length > 1 ? (
          <Choices
            label={t('avatar.color')}
            options={colors}
            value={spec.color ?? DEFAULT_COLOR}
            onPick={(color) => change({ color: color === DEFAULT_COLOR ? undefined : color })}
            className={styles.colors}
            render={(color) => ({
              name: color === DEFAULT_COLOR ? t('avatar.defaultColor') : t(`mascot.color.${color}`),
              className: styles.swatch,
              body: <span className={styles.dot} style={{ background: swatch(color) }} />,
            })}
          />
        ) : null}
        <Choices
          label={t('avatar.accessory')}
          options={ACCESSORIES}
          value={spec.accessory}
          onPick={(accessory) => change({ accessory })}
          className={styles.accessories}
          render={(accessory) => ({
            name: t(`mascot.accessory.${accessory}`),
            className: styles.accessory,
            body: t(`mascot.accessory.${accessory}`),
          })}
        />
      </div>
    </div>
  )
}
