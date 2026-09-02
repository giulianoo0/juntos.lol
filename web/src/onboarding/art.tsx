import { motion, useReducedMotion } from 'motion/react'

/**
 * The drawings for each onboarding step, as SVG so they inherit the theme.
 * Each animates a single idea, and only that idea wears the accent colour.
 */

const EASE = [0.23, 1, 0.32, 1] as const

const ENTER = 0.32
const STAGGER = 0.05

function useEnter() {
  const reduceMotion = useReducedMotion()
  return (delay: number) => (reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2 } }
    : {
      initial: { opacity: 0, y: 6 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: ENTER, delay, ease: EASE },
    })
}

/** A stroke that draws itself, for the lines whose direction is the meaning. */
function useDraw() {
  const reduceMotion = useReducedMotion()
  return (delay: number) => (reduceMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2 } }
    : {
      initial: { pathLength: 0, opacity: 0 },
      animate: { pathLength: 1, opacity: 1 },
      transition: { duration: 0.34, delay, ease: EASE },
    })
}

export function ArtTogether() {
  const enter = useEnter()
  const draw = useDraw()
  const reduceMotion = useReducedMotion()
  return (
    <svg className="onboard-art" viewBox="0 0 240 120" role="img" aria-hidden="true">
      <motion.rect x="64" y="8" width="112" height="58" rx="10" className="art-screen" {...enter(0)} />
      <motion.polygon points="112,24 112,40 128,32" className="art-person" {...enter(STAGGER)} />
      <motion.path d="M 80 54 H 160" className="art-person" {...enter(STAGGER)} />

      <motion.path
        d="M 80 54 H 124"
        className="art-tie"
        {...draw(STAGGER * 2)}
      />
      <motion.circle
        cx="124"
        cy="54"
        r="3.5"
        className="art-accent"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -44 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0 }}
        transition={{ duration: 0.34, delay: STAGGER * 2, ease: EASE }}
      />

      {[46, 120, 194].map((x, index) => (
        <motion.g key={x} {...enter(STAGGER * (2 + index))}>
          <circle cx={x} cy="92" r="8" className="art-person" />
          <path d={`M ${x - 12} 106 a 12 10 0 0 1 24 0`} className="art-person" />
        </motion.g>
      ))}
      {[46, 120, 194].map((x, index) => (
        <motion.path
          key={x}
          d={`M 120 68 L ${x} 82`}
          className="art-person"
          {...draw(STAGGER * (3 + index))}
        />
      ))}
    </svg>
  )
}

export function ArtOwn() {
  const enter = useEnter()
  const draw = useDraw()
  return (
    <svg className="onboard-art" viewBox="0 0 240 120" role="img" aria-hidden="true">
      <motion.g {...enter(0)}>
        <path
          d="M 96 56 v -20 a 24 24 0 0 1 48 0 v 20 h -10 v -20 a 14 14 0 0 0 -28 0 v 20 z"
          className="art-accent-fill"
        />
        <rect x="96" y="48" width="10" height="8" className="art-accent" />
        <rect x="134" y="48" width="10" height="8" className="art-accent" />
      </motion.g>

      <motion.g {...enter(STAGGER)}>
        <path d="M 22 20 h 20 l 8 8 v 26 h -28 z" className="art-card" />
        <path d="M 42 20 v 8 h 8" className="art-card-fold" />
      </motion.g>
      <motion.g {...enter(STAGGER * 2)}>
        <rect x="190" y="22" width="30" height="22" rx="4" className="art-card" />
        <path d="M 205 44 v 6 M 198 50 h 14" className="art-card-fold" />
      </motion.g>

      <motion.path d="M 36 58 L 106 76" className="art-person" {...draw(STAGGER * 3)} />
      <motion.path d="M 120 60 L 120 76" className="art-person" {...draw(STAGGER * 3)} />
      <motion.path d="M 205 54 L 134 76" className="art-person" {...draw(STAGGER * 3)} />

      <motion.rect x="84" y="78" width="72" height="38" rx="9" className="art-screen" {...enter(STAGGER * 4)} />
      <motion.polygon points="114,89 114,105 129,97" className="art-person" {...enter(STAGGER * 5)} />
    </svg>
  )
}

export function ArtCatalogue() {
  const enter = useEnter()
  const reduceMotion = useReducedMotion()
  return (
    <svg className="onboard-art" viewBox="0 0 240 120" role="img" aria-hidden="true">
      <motion.rect x="46" y="8" width="148" height="20" rx="10" className="art-field" {...enter(0)} />
      <motion.g {...enter(STAGGER)}>
        <circle cx="61" cy="18" r="4.5" className="art-person" />
        <path d="M 64.5 21.5 L 68 25" className="art-person" />
        <path d="M 78 18 h 44" className="art-person" />
      </motion.g>

      {[0, 1, 2, 3].map((index) => (
        <motion.rect
          key={index}
          x={46 + index * 39}
          y="38"
          width="31"
          height="44"
          rx="5"
          className="art-card"
          {...enter(STAGGER * (1 + index * 0.6))}
        />
      ))}

      <motion.path
        d="M 103 96 h 11 a 6 6 0 0 1 12 0 h 11 v 4 a 6 6 0 0 0 0 12 v 4 h -34 z"
        className="art-accent-fill"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={{ duration: 0.38, delay: STAGGER * 4, ease: EASE }}
      />
    </svg>
  )
}
