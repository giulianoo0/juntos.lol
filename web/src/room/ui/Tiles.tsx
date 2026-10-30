import { AppWindow, Crown, Focus, MicOff, Pin, PinOff, X } from 'lucide-react'
import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { Person, Stage } from '../model'
import { RoundButton } from '../../ui/Pill'
import { Tip } from '../../ui/Tip'
import { sameTarget, useRoomUi } from './context'
import { Face } from './Face'
import { PersonMenu } from './PersonMenu'
import { ReactionBursts, useReactionMood, useReactions } from './Reactions'
import styles from './Tiles.module.css'

type TileSize = 'grid' | 'focus' | 'thumb'

type Look = { x: number; y: number }

// Below this the face is a stamp: it holds still instead of blinking.
const STILL_BELOW = 56
// The mascot's head fills about two thirds of its box.
const MASCOT_SCALE = 1.6

const clamp = (value: number) => Math.max(-1, Math.min(1, value))

/** Where a tile's face looks: at the pointer over it, or else, a little, at
    whoever speaks (or at the stage when nobody does). */
function useGaze(tile: RefObject<HTMLDivElement | null>, toward: string | null): { lookAt: Look | null; follow: (event: PointerEvent) => void; leave: () => void } {
  const [pointer, setPointer] = useState<Look | null>(null)
  const [glance, setGlance] = useState<Look | null>(null)
  useLayoutEffect(() => {
    const from = tile.current
    const to = toward ? document.querySelector(toward) : null
    if (!from || !to) { setGlance(null); return }
    const a = from.getBoundingClientRect()
    const b = to.getBoundingClientRect()
    const dx = b.left + b.width / 2 - (a.left + a.width / 2)
    const dy = b.top + b.height / 2 - (a.top + a.height / 2)
    const length = Math.hypot(dx, dy)
    setGlance(length < 1 ? null : { x: (dx / length) * 0.5, y: (dy / length) * 0.4 })
  }, [tile, toward])
  const follow = useCallback((event: PointerEvent) => {
    const box = event.currentTarget.getBoundingClientRect()
    setPointer({ x: clamp((event.clientX - box.left) / box.width * 2 - 1), y: clamp((event.clientY - box.top) / box.height * 2 - 1) })
  }, [])
  const leave = useCallback(() => setPointer(null), [])
  return { lookAt: pointer ?? glance, follow, leave }
}

/** Someone in the call: their camera, or their mascot (talking with their
    voice, answering their reactions, glancing at who speaks); the ring
    while they speak; the name tag with the muted mark; their reactions
    rising over it. `data-reaction` carries the last one. */
export function PersonTile({ person, size, avatar: avatarSize }: { person: Person; size: TileSize; avatar?: number }) {
  const { vm, strings, pin, setPin, spotlit } = useRoomUi()
  const tileRef = useRef<HTMLDivElement>(null)
  const target = { kind: 'person' as const, id: person.id }
  const pinned = sameTarget(pin, target)
  const lit = sameTarget(spotlit, target)
  const camera = person.cam && !person.hostCamOff
  const muted = !person.mic || person.hostMuted
  const avatar = avatarSize ?? (size === 'thumb' ? 40 : size === 'focus' ? 120 : 88)
  const reactions = useReactions(person.id)
  const mood = useReactionMood(reactions.last)
  const speaking = person.speaking && !muted
  const speaker = vm.people.find((other) => other.id !== person.id && other.speaking && other.mic && !other.hostMuted)
  const toward = speaker ? `[data-member="${CSS.escape(speaker.id)}"]` : vm.stages.length > 0 ? '[data-stage]' : null
  const gaze = useGaze(tileRef, camera ? null : toward)
  const { levelOf } = vm
  const level = useCallback(() => levelOf?.(person.id) ?? 0, [levelOf, person.id])
  return (
    <div
      ref={tileRef}
      className={styles.tile}
      data-size={size}
      data-speaking={speaking || undefined}
      data-camera={camera || undefined}
      data-member={person.id}
      data-reaction={reactions.last?.emoji}
      onPointerMove={camera ? undefined : gaze.follow}
      onPointerLeave={camera ? undefined : gaze.leave}
    >
      {camera ? <div className={styles.video}>{vm.slots.renderVideo(person.id)}</div> : (
        <span className={styles.face}>
          <Face
            id={person.id}
            avatar={person.avatar}
            size={Math.round(avatar * MASCOT_SCALE)}
            expression={mood ?? (speaking ? 'speaking' : 'idle')}
            level={levelOf ? level : undefined}
            lookAt={gaze.lookAt}
            still={avatar < STILL_BELOW}
          />
        </span>
      )}
      <ReactionBursts bursts={reactions.bursts} finish={reactions.finish} small={size === 'thumb' && avatar < 64} />
      <div className={styles.name}>
        {muted ? <MicOff size={13} aria-label={strings.micOff} role="img" /> : null}
        {person.host ? (
          <Tip label={strings.host}>
            <Crown size={12} className={styles.crown} fill="currentColor" aria-hidden="true" />
          </Tip>
        ) : null}
        <span className={styles.nameText}>{person.name}</span>
        {person.accountId ? <span className={styles.number}>#{person.accountId}</span> : null}
        {person.app ? <Tip label={strings.usingApp}><AppWindow size={12} className={styles.app} data-app="" aria-hidden="true" /></Tip> : null}
      </div>
      {size !== 'thumb' ? (
        <div className={styles.corner}>
          {pinned ? <span className={styles.tag}><Pin size={12} aria-hidden="true" />{strings.pinned}</span> : null}
          {lit ? <span className={styles.tag}><Focus size={12} aria-hidden="true" />{strings.spotlit}</span> : null}
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
  const reading = size !== 'thumb' ? vm.slots.renderStageTag?.(stage) : null
  return (
    <div className={styles.tile} data-size={size} data-stage={stage.kind}>
      <div className={styles.stage}>{vm.slots.renderStage(stage, size === 'focus' ? 'focus' : 'thumb')}</div>
      <div className={styles.stageTags}>
        {/* The player keeps its own title; the header names the media. */}
        {stage.kind === 'media' && size !== 'thumb' ? null : <span className={styles.tag}>
          <Face id={stage.ownerId} avatar={vm.people.find((p) => p.id === stage.ownerId)?.avatar} size={18} />
          <span className={styles.nameText}>{size === 'thumb' ? stage.title : `${nameOf(stage.ownerId)} · ${stage.title}`}</span>
        </span>}
        {size !== 'thumb' && pinned ? <span className={styles.tag}><Pin size={12} aria-hidden="true" />{strings.pinned}</span> : null}
        {size !== 'thumb' && lit ? <span className={styles.tag}><Focus size={12} aria-hidden="true" />{strings.spotlit}</span> : null}
        {reading ? <span className={styles.tag} data-reading>{reading}</span> : null}
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
              icon={<Focus size={14} />}
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
