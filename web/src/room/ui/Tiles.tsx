import { Crown, MicOff, Pin, PinOff, Sparkles, X } from 'lucide-react'
import type { Person, Stage } from '../model'
import { Avatar } from '../../ui/Avatar'
import { RoundButton } from '../../ui/Pill'
import { Tip } from '../../ui/Tip'
import { sameTarget, useRoomUi } from './context'
import { PersonMenu } from './PersonMenu'
import styles from './Tiles.module.css'

type TileSize = 'grid' | 'focus' | 'thumb'

/** Someone in the call: their camera, or their face on their hue; the ring
    while they speak; the name tag with the muted mark. */
export function PersonTile({ person, size }: { person: Person; size: TileSize }) {
  const { vm, strings, pin, setPin, spotlit } = useRoomUi()
  const target = { kind: 'person' as const, id: person.id }
  const pinned = sameTarget(pin, target)
  const lit = sameTarget(spotlit, target)
  const camera = person.cam && !person.hostCamOff
  const muted = !person.mic || person.hostMuted
  const avatar = size === 'thumb' ? 40 : size === 'focus' ? 120 : 88
  return (
    <div className={styles.tile} data-size={size} data-speaking={person.speaking && !muted || undefined} data-camera={camera || undefined}>
      {camera ? <div className={styles.video}>{vm.slots.renderVideo(person.id)}</div> : <Avatar id={person.id} name={person.name} size={avatar} />}
      <div className={styles.name}>
        {muted ? <MicOff size={13} aria-label={strings.micOff} role="img" /> : null}
        <span className={styles.nameText}>{person.name}</span>
        {person.host ? (
          <Tip label={strings.host}>
            <Crown size={12} className={styles.crown} aria-hidden="true" />
          </Tip>
        ) : null}
      </div>
      {size !== 'thumb' ? (
        <div className={styles.corner}>
          {pinned ? <span className={styles.tag}><Pin size={12} aria-hidden="true" />{strings.pinned}</span> : null}
          {lit ? <span className={styles.tag}><Sparkles size={12} aria-hidden="true" />{strings.spotlit}</span> : null}
          <RoundButton
            tone="scrim"
            size="md"
            className={styles.cornerButton}
            label={pinned ? strings.unpin : strings.pin}
            icon={pinned ? <PinOff size={14} /> : <Pin size={14} />}
            onClick={() => setPin(pinned ? null : target)}
          />
          {vm.isHost ? (
            <PersonMenu
              person={person}
              trigger={<button type="button" className={`${styles.cornerMenu}`} />}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** A stage: the player, the live or a screen, with who opened it. */
export function StageTile({ stage, size }: { stage: Stage; size: TileSize }) {
  const { vm, strings, pin, setPin, spotlit, nameOf } = useRoomUi()
  const target = { kind: 'stage' as const, id: stage.id }
  const pinned = sameTarget(pin, target)
  const lit = sameTarget(spotlit, target)
  const canClose = vm.isHost || stage.ownerId === vm.selfId
  return (
    <div className={styles.tile} data-size={size} data-stage={stage.kind}>
      <div className={styles.stage}>{vm.slots.renderStage(stage, size === 'focus' ? 'focus' : 'thumb')}</div>
      <div className={styles.stageTags}>
        <span className={styles.tag}>
          <Avatar id={stage.ownerId} name={nameOf(stage.ownerId)} size={18} />
          <span className={styles.nameText}>{size === 'thumb' ? stage.title : `${nameOf(stage.ownerId)} · ${stage.title}`}</span>
        </span>
        {size !== 'thumb' && pinned ? <span className={styles.tag}><Pin size={12} aria-hidden="true" />{strings.pinned}</span> : null}
        {size !== 'thumb' && lit ? <span className={styles.tag}><Sparkles size={12} aria-hidden="true" />{strings.spotlit}</span> : null}
      </div>
      {size !== 'thumb' ? (
        <div className={styles.corner}>
          <RoundButton
            tone="scrim"
            size="md"
            className={styles.cornerButton}
            label={pinned ? strings.unpin : strings.pin}
            icon={pinned ? <PinOff size={14} /> : <Pin size={14} />}
            onClick={() => setPin(pinned ? null : target)}
          />
          {vm.isHost ? (
            <RoundButton
              tone="scrim"
              size="md"
              className={styles.cornerButton}
              label={lit ? strings.spotlightOff : strings.spotlightAll}
              icon={<Sparkles size={14} />}
              onClick={() => vm.actions.spotlight(lit ? null : stage.kind === 'screen' ? { kind: 'screen', memberId: stage.ownerId } : { kind: stage.kind })}
            />
          ) : null}
          {canClose ? (
            <RoundButton tone="scrim" size="md" className={styles.cornerButton} label={strings.closeStage} icon={<X size={14} />} onClick={() => vm.actions.closeStage(stage)} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
