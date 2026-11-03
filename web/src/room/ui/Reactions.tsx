import { useEffect, useRef, useState, type AnimationEvent, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { MascotExpression } from '../../mascot'
import { reactionMood } from '../avatar'
import type { Reaction } from '../model'
import { freshReactions, reactionSrc } from '../reactions'
import { useRoomUi } from './context'
import { Face } from './Face'
import styles from './Reactions.module.css'

// Long enough for the rise to end, should the animation never report it
// (a hidden tab).
const BURST_MS = 4_200
// More at once only crowd the tile.
const MAX_BURSTS = 8
// Over a whole screen there is room for a few more.
const MAX_FLOATING = 16

/** The last reaction someone sent while their tile was up. */
export interface LastReaction {
  emoji: string
  at: number
}

/**
 * The reactions to float out of `reactions`: the ones that arrive while
 * this is mounted, at most `max` at once, and the newest of them. What was
 * there at mount is history and never floats.
 */
function useBursts(reactions: Reaction[], max: number): { bursts: Reaction[]; last: LastReaction | null; finish: (id: string) => void } {
  const key = reactions.map(({ id }) => id).join(',')
  const seen = useRef<Set<string> | null>(null)
  if (seen.current === null) seen.current = new Set(reactions.map(({ id }) => id))
  const [bursts, setBursts] = useState<Reaction[]>([])
  const [last, setLast] = useState<LastReaction | null>(null)
  const timers = useRef<number[]>([])

  const finish = (id: string) => setBursts((current) => current.filter((burst) => burst.id !== id))

  useEffect(() => {
    const known = seen.current ?? new Set<string>()
    const fresh = freshReactions(reactions, known, Date.now())
    for (const { id } of reactions) known.add(id)
    const newest = fresh.at(-1)
    if (!newest) return
    setBursts((current) => [...current, ...fresh].slice(-max))
    setLast({ emoji: newest.emoji, at: newest.at })
    for (const { id } of fresh) timers.current.push(window.setTimeout(() => finish(id), BURST_MS))
    // `key` stands for `reactions`: a new reaction, not a new array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer) }, [])

  return { bursts, last, finish }
}

/** Someone's reactions as their tile shows them: the ones floating now, and the last one (for the face to answer). */
export function useReactions(memberId: string): { bursts: Reaction[]; last: LastReaction | null; finish: (id: string) => void } {
  const { vm } = useRoomUi()
  return useBursts(vm.reactions.filter((reaction) => reaction.memberId === memberId), MAX_BURSTS)
}

// Where along the tile a reaction rises and how it leans: from its id, so
// a few at once spread out and a re-render never moves one.
function spread(id: string): { x: number; tilt: number; sway: number } {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  const unit = (shift: number) => ((hash >>> shift) & 0xff) / 0xff
  return { x: (unit(0) - 0.5) * 56, tilt: (unit(8) - 0.5) * 28, sway: 6 + unit(16) * 8 }
}

/** The reactions rising over a tile: up, swaying, gone in a blur. */
export function ReactionBursts({ bursts, finish, small }: { bursts: Reaction[]; finish: (id: string) => void; small: boolean }) {
  if (bursts.length === 0) return null
  return (
    <div className={styles.bursts} data-small={small || undefined} aria-hidden="true">
      {bursts.map((burst) => {
        const src = reactionSrc(burst.emoji)
        if (!src) return null
        const { x, tilt, sway } = spread(burst.id)
        return (
          <span
            key={burst.id}
            className={styles.sway}
            style={{ '--x': `${x}%`, '--tilt': `${tilt}deg`, '--sway': `${sway}px` } as CSSProperties}
          >
            <img data-reaction-burst className={styles.emoji} src={src} alt="" draggable={false} onAnimationEnd={() => finish(burst.id)} />
          </span>
        )
      })}
    </div>
  )
}

type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null }

/** The stage filling the screen, native or pinned over the page (an iPhone), or null. */
function useFullscreenHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const read = () => {
      const doc = document as FullscreenDocument
      const native = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
      setHost((native ?? document.querySelector('.is-pseudo-fullscreen')) as HTMLElement | null)
    }
    read()
    document.addEventListener('fullscreenchange', read)
    document.addEventListener('webkitfullscreenchange', read)
    // The pinned stage marks the page with a class, and fires no event.
    const pinned = new MutationObserver(read)
    pinned.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => {
      document.removeEventListener('fullscreenchange', read)
      document.removeEventListener('webkitfullscreenchange', read)
      pinned.disconnect()
    }
  }, [])
  return host
}

/**
 * Everyone's reactions over a stage in fullscreen, where no tile shows
 * them: up from the bottom right across most of the screen, each with the
 * face of who sent it.
 */
export function FullscreenReactions() {
  const { vm } = useRoomUi()
  const host = useFullscreenHost()
  const { bursts, finish } = useBursts(vm.reactions, MAX_FLOATING)
  if (!host || bursts.length === 0) return null
  return createPortal(
    <div className={styles.floating} aria-hidden="true">
      {bursts.map((burst) => {
        const src = reactionSrc(burst.emoji)
        if (!src) return null
        const { x, tilt, sway } = spread(burst.id)
        const person = vm.people.find((each) => each.id === burst.memberId)
        const done = (event: AnimationEvent) => { if (event.target === event.currentTarget) finish(burst.id) }
        return (
          <span
            key={burst.id}
            className={styles.drift}
            style={{ '--x': `${x / 4}%`, '--tilt': `${tilt}deg`, '--sway': `${sway * 2}px` } as CSSProperties}
          >
            <span data-reaction-float className={styles.lift} onAnimationEnd={done}>
              <img className={styles.emoji} src={src} alt="" draggable={false} />
              {person ? <Face id={person.id} avatar={person.avatar} size={22} className={styles.sender} /> : null}
            </span>
          </span>
        )
      })}
    </div>,
    host,
  )
}

/** How long a face keeps answering its own reaction. */
const MOOD_MS = 1_500

/** The face's answer to its person's last reaction: cheering or wondering for a moment, then nothing. */
export function useReactionMood(last: LastReaction | null): MascotExpression | null {
  const [mood, setMood] = useState<MascotExpression | null>(null)
  useEffect(() => {
    const next = last ? reactionMood(last.emoji) : null
    setMood(next)
    if (!next) return
    const timer = window.setTimeout(() => setMood(null), MOOD_MS)
    return () => window.clearTimeout(timer)
  }, [last])
  return mood
}
