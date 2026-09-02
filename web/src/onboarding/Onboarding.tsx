import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useT } from '../i18n/useT'
import { MorphPanel } from '../ui/MorphPanel'
import { ArtCatalogue, ArtOwn, ArtTogether } from './art'
import { playAdvance, playBack, playFinish } from './sounds'
import { markSeen } from './seen'
import './onboarding.css'

const STEPS = ['welcome', 'own', 'catalogue'] as const
type Step = typeof STEPS[number]

const SLIDE = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 36, filter: 'blur(5px)' }),
  middle: { opacity: 1, x: 0, filter: 'blur(0px)' },
  leave: (direction: number) => ({ opacity: 0, x: direction * -36, filter: 'blur(5px)' }),
}

const REDUCED = { enter: { opacity: 0 }, middle: { opacity: 1 }, leave: { opacity: 0 } }

const ART: Record<Step, () => React.JSX.Element> = {
  welcome: ArtTogether,
  own: ArtOwn,
  catalogue: ArtCatalogue,
}

/** What this app is, shown once to someone who has never seen it. */
export function Onboarding({ onDone }: { onDone?: () => void }) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const [index, setIndex] = useState(0)
  const [direction, setDirection] = useState(1)
  const [closing, setClosing] = useState(false)
  const step = STEPS[index]

  const finish = useCallback(() => {
    markSeen()
    setClosing(true)
    onDone?.()
  }, [onDone])

  const advance = () => {
    if (index === STEPS.length - 1) {
      playFinish()
      finish()
      return
    }
    playAdvance()
    setDirection(1)
    setIndex(index + 1)
  }

  const back = () => {
    if (index === 0) return
    playBack()
    setDirection(-1)
    setIndex(index - 1)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish()
      if (event.key === 'ArrowRight') advance()
      if (event.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (closing) return null

  const Art = ART[step]
  const last = index === STEPS.length - 1

  return (
    <div className="onboard-backdrop" role="dialog" aria-modal="true" aria-label={t('onboard.title')}>
      {/* morphing stays false: MorphPanel's own dissolve stacked on the
          steps' cross-fade made the panel vanish and come back. */}
      <MorphPanel sizeKey={step} morphing={false} className="onboard-morph">
        <div className="onboard-panel">
          <div className="onboard-stage">
          {/* Both steps share one grid cell (see .onboard-stage) so they
              overlap; `popLayout` took the leaver out of flow and the panel
              collapsed for a frame. */}
          <AnimatePresence initial={false} custom={direction}>
            <motion.div
              key={step}
              className="onboard-step"
              custom={direction}
              variants={reduceMotion ? REDUCED : SLIDE}
              initial="enter"
              animate="middle"
              exit="leave"
              transition={{ duration: 0.28, ease: [0.23, 1, 0.32, 1] }}
            >
              <Art />
              <h2>{t(`onboard.${step}.title`)}</h2>
              <p>{t(`onboard.${step}.body`)}</p>
              {step !== 'welcome' ? (
                <p className="onboard-aside">{t(`onboard.${step}.aside`)}</p>
              ) : null}
            </motion.div>
            </AnimatePresence>
          </div>

          <div className="onboard-controls">
            <div className="onboard-dots" aria-hidden="true">
              {STEPS.map((value, position) => (
                <span key={value} className={position === index ? 'is-active' : ''} />
              ))}
            </div>
            <div className="onboard-buttons">
              {index > 0 ? (
                <button type="button" className="onboard-back" onClick={back}>{t('onboard.back')}</button>
              ) : (
                <button type="button" className="onboard-back" onClick={finish}>{t('onboard.skip')}</button>
              )}
              <button type="button" className="primary-button raised" onClick={advance}>
                {last ? t('onboard.start') : t('onboard.next')}
              </button>
            </div>
          </div>
        </div>
      </MorphPanel>
    </div>
  )
}
