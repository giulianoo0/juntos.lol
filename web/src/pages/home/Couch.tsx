import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useT } from '../../i18n/useT'
import { Mascot, type MascotAccessory, type MascotKind } from '../../mascot'
import { REACTIONS, reactionSrc } from '../../room/reactions'
import styles from './Couch.module.css'

const CREW: { kind: MascotKind; accessory: MascotAccessory; color?: string; size: number }[] = [
  { kind: 'bunny', accessory: 'flower', size: 96 },
  { kind: 'robot', accessory: 'none', size: 104 },
  { kind: 'fox', accessory: 'bowtie', size: 118 },
  { kind: 'mushroom', accessory: 'none', size: 92 },
  { kind: 'bear', accessory: 'cap', size: 112 },
  { kind: 'ghost', accessory: 'none', size: 96 },
  { kind: 'frog', accessory: 'crown', size: 100 },
  { kind: 'cat', accessory: 'headphones', color: 'preto', size: 104 },
]

const HAPPY_MS = 1_600

type Look = { x: number; y: number } | null
type Burst = { id: number; seat: number; src: string }

/**
 * The crew on the couch under the hero: they sway, blink, follow the
 * pointer with their eyes, and a click makes one happy and sends up an
 * emoji.
 */
export function Couch() {
  const t = useT()
  const seatsRef = useRef<(HTMLButtonElement | null)[]>([])
  const [looks, setLooks] = useState<Look[]>(() => CREW.map(() => null))
  const [happy, setHappy] = useState<ReadonlySet<number>>(new Set())
  const [bursts, setBursts] = useState<Burst[]>([])
  const nextBurst = useRef(0)

  useEffect(() => {
    let frame = 0
    let pointer: { x: number; y: number } | null = null
    const update = () => {
      frame = 0
      if (!pointer) return
      const { x, y } = pointer
      setLooks(seatsRef.current.map((seat) => {
        if (!seat) return null
        const box = seat.getBoundingClientRect()
        return {
          x: (x - (box.left + box.width / 2)) / (window.innerWidth / 2),
          y: (y - (box.top + box.height / 2)) / (window.innerHeight / 2),
        }
      }))
    }
    const move = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY }
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    const leave = () => {
      pointer = null
      setLooks(CREW.map(() => null))
    }
    window.addEventListener('pointermove', move, { passive: true })
    document.documentElement.addEventListener('pointerleave', leave)
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      document.documentElement.removeEventListener('pointerleave', leave)
    }
  }, [])

  const cheer = (seat: number) => {
    const emoji = REACTIONS[Math.floor(Math.random() * REACTIONS.length)]!
    const src = reactionSrc(emoji)
    const id = nextBurst.current++
    if (src) setBursts((all) => [...all, { id, seat, src }])
    setHappy((all) => new Set(all).add(seat))
    window.setTimeout(() => {
      setHappy((all) => {
        const next = new Set(all)
        next.delete(seat)
        return next
      })
    }, HAPPY_MS)
  }

  return (
    <div className={styles.couch}>
      <div className={styles.cushion} aria-hidden="true" />
      <div className={styles.crew}>
        {CREW.map((member, index) => (
          <button
            key={member.kind}
            ref={(element) => { seatsRef.current[index] = element }}
            type="button"
            className={styles.seat}
            style={{ '--seat': `${member.size}px`, '--delay': `${-index * 0.4}s` } as CSSProperties}
            aria-label={t(`mascot.kind.${member.kind}`)}
            onClick={() => cheer(index)}
          >
            {bursts.filter((burst) => burst.seat === index).map((burst) => (
              <img
                key={burst.id}
                className={styles.burst}
                src={burst.src}
                alt=""
                width={34}
                height={34}
                onAnimationEnd={() => setBursts((all) => all.filter((other) => other.id !== burst.id))}
              />
            ))}
            <span className={styles.sway}>
              <Mascot
                kind={member.kind}
                color={member.color}
                accessory={member.accessory}
                expression={happy.has(index) ? 'happy' : 'idle'}
                lookAt={looks[index] ?? null}
                size={member.size}
                className={styles.face}
              />
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
