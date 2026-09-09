import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { Download } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { JLOCAL_RELEASES_URL, useJlocal } from '../jlocal/useJlocal'
import { MORPH_EASE } from '../ui/morphTokens'
import { SlotText } from '../ui/SlotText'

/**
 * The companion's place in the header: a download link while jlocal is not
 * running, and a status pill that says so. The moment the app answers on
 * loopback the link folds away, the pill slides into its place and its line
 * travels from "não conectado" to "conectado".
 */
export function JlocalPill({ t }: { t: Translator }) {
  const { connected, version } = useJlocal()
  const still = useReducedMotion() ?? false
  const transition = still ? { duration: 0 } : { duration: 0.36, ease: MORPH_EASE }
  return (
    <LayoutGroup id="jlocal">
      <span className="jlocal-slot">
        <motion.span
          layout
          transition={transition}
          className={`jlocal-pill ${connected ? 'is-on' : ''}`}
          title={connected && version ? `jlocal ${version}` : undefined}
          role="status"
        >
          <span className="jlocal-dot" aria-hidden="true" />
          <SlotText k={connected ? 'on' : 'off'}>{t(connected ? 'jlocal.on' : 'jlocal.off')}</SlotText>
        </motion.span>
        <AnimatePresence mode="popLayout" initial={false}>
          {connected ? null : (
            <motion.a
              key="get"
              layout
              className="jlocal-get"
              href={JLOCAL_RELEASES_URL}
              target="_blank"
              rel="noreferrer"
              initial={still ? false : { opacity: 0, scale: 0.9, filter: 'blur(4px)' }}
              animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
              exit={still ? { opacity: 0 } : { opacity: 0, scale: 0.85, filter: 'blur(6px)' }}
              transition={transition}
            >
              <Download size={14} aria-hidden="true" />{t('jlocal.get')}
            </motion.a>
          )}
        </AnimatePresence>
      </span>
    </LayoutGroup>
  )
}
