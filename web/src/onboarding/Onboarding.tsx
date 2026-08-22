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

/**
 * The step travels sideways, in the direction you asked for.
 *
 * A cross-fade in place reads as the same card changing its mind; a slide
 * reads as moving through a sequence, which is what this is.
 */
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

/**
 * What this is, once, for someone who has never seen it.
 *
 * It exists because the two tabs do genuinely different things and neither
 * name explains itself: a room is media you already have, the catalogue is a
 * search that finds nothing until a plugin is installed. Someone who learns
 * that by clicking around learns it as a failure.
 */
export function Onboarding({ onDone }: { onDone?: () => void }) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  const [index, setIndex] = useState(0)
  // Which way the content should travel. Going forward it enters from the
  // right and leaves to the left; going back, the reverse. Without this both
  // directions look identical and the panel loses its sense of place.
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

  // Escape skips it. Somebody who already knows the app should not have to
  // click through three screens to reach it.
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
      {/* morphing stays false on purpose. MorphPanel's own dissolve takes the
          whole pane to opacity 0 for a beat, which is right when the caller
          does nothing itself — here the steps cross-fade and slide past each
          other, and stacking the two made the panel vanish and come back.
          The panel keeps the job of travelling between sizes; the content
          keeps the job of changing. */}
      <MorphPanel sizeKey={step} morphing={false} className="onboard-morph">
        <div className="onboard-panel">
          <div className="onboard-stage">
          {/* Both steps live in the same grid cell (see .onboard-stage), so
              the outgoing and incoming ones overlap instead of following each
              other. `popLayout` took the leaver out of flow and the panel
              collapsed to nothing for a frame — the box blinked. Stacked, the
              height is always somebody's, and it travels between them. */}
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
