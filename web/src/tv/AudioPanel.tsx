import { Clapperboard, X } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useT } from '../i18n/useT'
import { Face } from '../room/ui/Face'
import { memberVolumes, onlyMedia, withMedia, withPerson, type Mix } from './mix'
import styles from './tv.module.css'

const STEP = 0.05

function Level({ label, value, onChange, autoFocus }: { label: string; value: number; onChange: (value: number) => void; autoFocus?: boolean }) {
  return (
    <input
      type="range"
      className={styles.level}
      min={0}
      max={1}
      step={STEP}
      value={value}
      aria-label={label}
      autoFocus={autoFocus}
      style={{ '--level': `${value * 100}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}

/**
 * How loud the TV plays the media and each person, the same mix the phone
 * that mirrored sees. Left and right on a slider turn it; the owner's voice,
 * already in the living room, starts at 0.
 */
export function AudioPanel({ mix, people, ownerId, onChange, onClose }: {
  mix: Mix
  people: { id: string; name: string; avatar?: string }[]
  ownerId: string | null
  onChange: (mix: Mix) => void
  onClose: () => void
}) {
  const t = useT()
  const volumes = memberVolumes(mix, people.map((person) => person.id), ownerId)
  return (
    <div className={styles.panel} role="dialog" aria-label={t('tv.audio')} data-tv-overlay="">
      <header className={styles.panelHeader}>
        <h2>{t('tv.audio')}</h2>
        <button type="button" className={styles.roundButton} aria-label={t('home.closeDialog')} onClick={onClose}>
          <X size={22} aria-hidden="true" />
        </button>
      </header>
      <div className={styles.mixRow}>
        <span className={styles.mixIcon}><Clapperboard size={26} aria-hidden="true" /></span>
        <span className={styles.mixName}>{t('tv.media')}</span>
        <Level label={t('tv.media')} value={mix.media} onChange={(value) => onChange(withMedia(mix, value))} autoFocus />
      </div>
      {people.map((person) => (
        <div key={person.id} className={styles.mixRow}>
          <span className={styles.mixIcon}><Face id={person.id} avatar={person.avatar} size={44} /></span>
          <span className={styles.mixName}>{person.name}</span>
          <Level label={t('tv.volumeOf').replace('{name}', person.name)} value={volumes[person.id] ?? 1} onChange={(value) => onChange(withPerson(mix, person.id, value))} />
        </div>
      ))}
      {people.length > 0 ? (
        <button type="button" className={styles.panelAction} onClick={() => onChange(onlyMedia(mix, people.map((person) => person.id)))}>
          {t('tv.onlyMedia')}
        </button>
      ) : null}
    </div>
  )
}
