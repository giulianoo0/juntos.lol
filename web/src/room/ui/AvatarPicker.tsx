import type { CSSProperties } from 'react'
import { KINDS, MASCOT_ACCESSORIES, MASCOT_KINDS, Mascot, parseAvatar, serializeAvatar, type AvatarSpec } from '../../mascot'
import { useRoomStrings } from './strings'
import styles from './AvatarPicker.module.css'

const FALLBACK: AvatarSpec = { kind: 'fox', accessory: 'bowtie' }

/** The door's compact avatar editor: the kind, its colors, what it wears.
    `value` and `onChange` speak the avatar string (`cat-preto.beanie`). */
export function AvatarPicker({ value, onChange }: { value: string; onChange: (avatar: string) => void }) {
  const strings = useRoomStrings()
  const spec = parseAvatar(value) ?? FALLBACK
  const colors = Object.entries(KINDS[spec.kind].colors ?? {})
  const pick = (next: Partial<AvatarSpec>) => onChange(serializeAvatar({ ...spec, ...next }))

  return (
    <div className={styles.picker}>
      <div className={styles.group} role="group" aria-label={strings.avatar}>
        <span className={styles.label} aria-hidden="true">{strings.avatar}</span>
        <div className={styles.kinds}>
          {MASCOT_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={styles.kind}
              aria-label={KINDS[kind].name}
              title={KINDS[kind].name}
              aria-pressed={kind === spec.kind}
              onClick={() => pick({ kind, color: undefined })}
            >
              <Mascot kind={kind} expression="idle" accessory="none" size={40} still />
            </button>
          ))}
        </div>
      </div>

      {colors.length > 0 ? (
        <div className={styles.group} role="group" aria-label={strings.color}>
          <span className={styles.label} aria-hidden="true">{strings.color}</span>
          <div className={styles.chips}>
            {[[undefined, KINDS[spec.kind].body] as const, ...colors.map(([name, palette]) => [name, palette.body ?? KINDS[spec.kind].body] as const)].map(([name, body]) => (
              <button
                key={name ?? ''}
                type="button"
                className={styles.swatch}
                style={{ '--swatch': body } as CSSProperties}
                aria-label={name ?? strings.defaultColor}
                title={name ?? strings.defaultColor}
                aria-pressed={spec.color === name}
                onClick={() => pick({ color: name })}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className={styles.group} role="group" aria-label={strings.accessory}>
        <span className={styles.label} aria-hidden="true">{strings.accessory}</span>
        <div className={styles.chips}>
          {MASCOT_ACCESSORIES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={styles.chip}
              aria-pressed={id === spec.accessory}
              onClick={() => pick({ accessory: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
