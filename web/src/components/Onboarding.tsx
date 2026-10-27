import { useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { discordLoginUrl, useMe } from '../account'
import { useT } from '../i18n/useT'
import { Mascot } from '../mascot'
import { reactionSrc } from '../room/reactions'
import { DiscordGlyph } from '../ui/DiscordGlyph'
import { Modal } from '../ui/Modal'
import { MorphSize } from '../ui/MorphSize'
import { Pill, PillLink } from '../ui/Pill'
import styles from './Onboarding.module.css'

const SEEN_KEY = 'ss.onboarding.v2'

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Private mode: it shows again next visit, nothing breaks.
  }
}

const CREW = [
  { kind: 'fox', accessory: 'bowtie' },
  { kind: 'frog', accessory: 'crown' },
  { kind: 'ghost', accessory: 'none' },
  { kind: 'robot', accessory: 'none' },
  { kind: 'bunny', accessory: 'flower' },
] as const

const KINDS = ['cat', 'axolotl', 'mushroom', 'penguin', 'planet', 'onigiri'] as const

function Emoji({ emoji, size = 40 }: { emoji: string; size?: number }) {
  const src = reactionSrc(emoji)
  return src ? <img src={src} alt="" width={size} height={size} className={styles.emoji} /> : null
}

/** The first visit after the new juntos: what changed, a step at a time. */
export function Onboarding() {
  const t = useT()
  const { me } = useMe()
  const location = useLocation()
  const [open, setOpen] = useState(() => !seen())
  const [step, setStep] = useState(0)
  // The step on its way out, blurring away over the one coming in.
  const [leaving, setLeaving] = useState<number | null>(null)

  if (location.pathname.startsWith('/dev')) return null

  const steps: { title: string; text: string; hero: ReactNode }[] = [
    {
      title: t('onboarding.crewTitle'),
      text: t('onboarding.crewText'),
      hero: (
        <div className={styles.crew}>
          {CREW.map((face, index) => (
            <span key={face.kind} className={styles.bob} style={{ animationDelay: `${-index * 0.5}s` }}>
              <Mascot kind={face.kind} accessory={face.accessory} expression={index === 1 ? 'speaking' : index === 2 ? 'happy' : 'idle'} size={62} />
            </span>
          ))}
        </div>
      ),
    },
    {
      title: t('onboarding.buildTitle'),
      text: t('onboarding.buildText'),
      hero: (
        <div className={styles.kinds}>
          {KINDS.map((kind, index) => (
            <span key={kind} className={styles.pop} style={{ animationDelay: `${index * 70}ms` }}>
              <Mascot kind={kind} accessory={index % 2 ? 'none' : 'beanie'} expression="idle" size={64} />
            </span>
          ))}
        </div>
      ),
    },
    {
      title: t('onboarding.accountTitle'),
      text: t('onboarding.accountText'),
      hero: (
        <div className={styles.number}>
          <Mascot kind="fox" accessory="bowtie" expression="happy" size={96} />
          <span className={styles.digits}>#{me?.id ?? 128}</span>
        </div>
      ),
    },
    {
      title: t('onboarding.friendsTitle'),
      text: t('onboarding.friendsText'),
      hero: (
        <div className={styles.friends}>
          <Mascot kind="bear" accessory="cap" expression="idle" size={84} />
          <span className={styles.wave}><Emoji emoji="👏" size={34} /></span>
          <Mascot kind="cat" accessory="none" expression="happy" size={84} />
        </div>
      ),
    },
    {
      title: t('onboarding.reactTitle'),
      text: t('onboarding.reactText'),
      hero: (
        <div className={styles.react}>
          <span className={styles.rise}><Emoji emoji="😂" /></span>
          <span className={styles.rise} style={{ animationDelay: '-0.9s' }}><Emoji emoji="🔥" size={32} /></span>
          <span className={styles.rise} style={{ animationDelay: '-1.7s' }}><Emoji emoji="❤️" size={30} /></span>
          <Mascot kind="ghost" accessory="none" expression="happy" size={96} />
        </div>
      ),
    },
  ]

  const last = step === steps.length - 1
  const current = steps[step]!
  const go = (next: number) => {
    setLeaving(step)
    setStep(next)
  }
  const view = (index: number) => (
    <>
      <div className={styles.hero} aria-hidden="true">{steps[index]!.hero}</div>
      <p className={styles.text}>{steps[index]!.text}</p>
    </>
  )
  const close = () => {
    markSeen()
    setOpen(false)
  }

  return (
    <Modal open={open} onOpenChange={(next) => { if (!next) close() }} title={current.title} closeLabel={t('onboarding.skip')}>
      <div className={styles.body}>
        <div className={styles.stage}>
          {leaving !== null && leaving !== step ? (
            <div key={`out-${leaving}`} className={styles.leaving} aria-hidden="true" onAnimationEnd={() => setLeaving(null)}>{view(leaving)}</div>
          ) : null}
          <MorphSize step={String(step)} axis="height">
            <div className={styles.step}>{view(step)}</div>
          </MorphSize>
        </div>
        <div className={styles.dots} aria-hidden="true">
          {steps.map((_, index) => <span key={index} className={styles.dot} data-on={index === step || undefined} />)}
        </div>
        <div className={styles.actions}>
          {step > 0 ? (
            <Pill tone="soft" size="lg" onClick={() => go(step - 1)}>{t('onboarding.back')}</Pill>
          ) : (
            <Pill tone="soft" size="lg" onClick={close}>{t('onboarding.skip')}</Pill>
          )}
          {last && !me ? (
            <PillLink tone="soft" size="lg" icon={<DiscordGlyph size={16} />} href={discordLoginUrl(location.pathname)} onClick={markSeen}>
              {t('onboarding.signIn')}
            </PillLink>
          ) : null}
          <Pill tone="brand" size="lg" onClick={last ? close : () => go(step + 1)}>
            {last ? t('onboarding.done') : t('onboarding.next')}
          </Pill>
        </div>
      </div>
    </Modal>
  )
}
