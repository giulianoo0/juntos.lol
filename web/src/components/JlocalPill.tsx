import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Translator } from '../i18n/useT'
import type { JLocalSnapshot as JlocalStatus } from '../jlocal/status'
import { MORPH_EASE } from '../ui/morphTokens'

/**
 * The companion's two places in a header. While jlocal is not running, the
 * status pill sits at the start ("não conectado") and the download link at
 * the end. The moment the app answers on loopback the link folds away and
 * the pill travels across the header into the link's spot, its line changing
 * to "conectado" on the way. Both halves share one `layoutId`, and the
 * header wraps them in a `LayoutGroup`, which is what makes the trip one
 * continuous move rather than a disappearance and a reappearance.
 */

const TRAVEL = 0.55
const PILL_ID = 'jlocal-pill'

function Pill({ connected, version, t }: { connected: boolean; version: string | null; t: Translator }) {
  const still = useReducedMotion() ?? false
  const travel = still ? { duration: 0 } : { duration: TRAVEL, ease: MORPH_EASE }
  const line = still
    ? { duration: 0 }
    : { duration: 0.32, ease: MORPH_EASE, delay: connected ? TRAVEL * 0.45 : 0 }
  return (
    <motion.span
      layoutId={PILL_ID}
      layout="position"
      transition={travel}
      initial={false}
      exit={{ opacity: 0, transition: { duration: still ? 0 : 0.18 } }}
      className={`jlocal-pill ${connected ? 'is-on' : ''}`}
      title={connected && version ? `jlocal ${version}` : undefined}
      role="status"
    >
      <span className="jlocal-dot" aria-hidden="true" />
      <span className="slot-text">
        <motion.span
          key={connected ? 'on' : 'off'}
          initial={still ? false : { transform: 'translateY(100%)', opacity: 0, filter: 'blur(5px)' }}
          animate={{ transform: 'translateY(0%)', opacity: 1, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
          transition={line}
        >
          {t(connected ? 'jlocal.on' : 'jlocal.off')}
        </motion.span>
      </span>
    </motion.span>
  )
}

/** The start of the header: the pill, only while jlocal is absent. */
export function JlocalStatus({ status, t }: { status: JlocalStatus; t: Translator }) {
  return (
    <AnimatePresence initial={false}>
      {status.connected ? null : <Pill key="start" connected={false} version={null} t={t} />}
    </AnimatePresence>
  )
}
