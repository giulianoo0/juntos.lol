import { Lock, Mic, MicOff, Video, VideoOff } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react'
import type { EntryViewModel, WaitingViewModel } from '../model'
import { Mascot, parseAvatar, type MascotExpression } from '../../mascot'
import { avatarOf } from '../avatar'
import { Field } from '../../ui/Field'
import { IconPill } from '../../ui/IconPill'
import { Pill } from '../../ui/Pill'
import { arrive } from '../../ui/arrive'
import { Loading, Skeleton } from '../../ui/Shimmer'
import { AvatarEditor } from '../../account/AvatarEditor'
import { Face, FaceStack } from './Face'
import { presentLine, useRoomStrings } from './strings'
import styles from './Entry.module.css'

/** How long the mascot beams at a new look. */
const CHEER_MS = 1_200
const HERO_SIZE = 200

type Look = { x: number; y: number }

const clamp = (value: number) => Math.max(-1, Math.min(1, value))

/** The mascot follows the cursor anywhere on the page, within reason. */
function usePointerGaze(hero: RefObject<HTMLDivElement | null>): Look | null {
  const [look, setLook] = useState<Look | null>(null)
  useEffect(() => {
    let frame = 0
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const box = hero.current?.getBoundingClientRect()
        if (!box) return
        const reach = Math.max(box.width, 320)
        setLook({ x: clamp((event.clientX - (box.left + box.width / 2)) / reach), y: clamp((event.clientY - (box.top + box.height / 2)) / reach) })
      })
    }
    const away = () => setLook(null)
    window.addEventListener('pointermove', move)
    document.documentElement.addEventListener('pointerleave', away)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', move)
      document.documentElement.removeEventListener('pointerleave', away)
    }
  }, [hero])
  return look
}

/** A small hop with the spring for a new look; nothing when motion is reduced. */
function hop(element: HTMLElement | null) {
  if (!element?.animate || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const easing = getComputedStyle(element).getPropertyValue('--ease-spring-pop').trim() || 'ease-out'
  element.animate([{ scale: '0.88' }, { scale: '1' }], { duration: 600, easing })
}

/** Before the room: your mascot (your camera beside it, when on), your
    name, how you look and, when asked, the password. */
export function EntryScreen({ vm }: { vm: EntryViewModel }) {
  const strings = useRoomStrings()
  const [nickname, setNickname] = useState(vm.nickname)
  const [password, setPassword] = useState('')
  const [avatar, setAvatar] = useState(vm.avatar)
  const [cheer, setCheer] = useState(0)
  const heroRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const lookAt = usePointerGaze(heroRef)
  const needsPassword = vm.joinMode === 'password'
  const ready = (!needsPassword || password !== '') && !vm.busy
  const present = vm.present.map((name, index) => ({ id: `${index}:${name}` }))
  const spec = parseAvatar(avatar) ?? avatarOf(undefined, nickname)

  // The account's avatar arrives after the page does, and takes over.
  useEffect(() => { setAvatar(vm.avatar) }, [vm.avatar])

  useEffect(() => {
    if (!cheer) return
    const timer = window.setTimeout(() => setCheer(0), CHEER_MS)
    return () => window.clearTimeout(timer)
  }, [cheer])

  const choose = (next: string) => {
    setAvatar(next)
    setCheer((count) => count + 1)
    vm.setAvatar(next)
    hop(popRef.current)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready) vm.join({ nickname: nickname.trim(), password })
  }

  const expression: MascotExpression = cheer ? 'happy' : vm.mic && vm.level ? 'speaking' : 'idle'

  return (
    <div className={`${styles.page} ${arrive}`}>
      <div className={styles.stage}>
        <div className={styles.hero} ref={heroRef} data-hero>
          <div ref={popRef} className={styles.pop}>
            <div className={styles.bob}>
              <Mascot
                kind={spec.kind}
                color={spec.color}
                accessory={spec.accessory}
                expression={expression}
                level={vm.mic ? vm.level : undefined}
                lookAt={lookAt}
                size={HERO_SIZE}
                className={styles.mascot}
              />
            </div>
          </div>
          {vm.cam ? <div className={styles.camera}>{vm.renderPreview()}</div> : null}
        </div>
        <div className={styles.toggles}>
          <IconPill size="sm" label={vm.mic ? strings.mic : strings.micOff} icon={vm.mic ? <Mic size={16} /> : <MicOff size={16} />} state={vm.mic ? undefined : 'off'} aria-pressed={vm.mic} onClick={() => vm.setMic(!vm.mic)} />
          <IconPill size="sm" label={vm.cam ? strings.cam : strings.camOff} icon={vm.cam ? <Video size={16} /> : <VideoOff size={16} />} state={vm.cam ? undefined : 'off'} aria-pressed={vm.cam} onClick={() => vm.setCam(!vm.cam)} />
        </div>
        <div className={styles.looks}>
          <AvatarEditor value={avatar} onChange={choose} only="looks" />
        </div>
      </div>

      <form className={styles.form} onSubmit={submit}>
        <div className={styles.title}>
          <h1 className={styles.name}>{vm.name}</h1>
          <div className={styles.present}>
            {present.length > 0 ? <FaceStack people={present} size={22} /> : null}
            <span>{presentLine(strings, vm.present, vm.presentCount)}</span>
          </div>
        </div>
        <Field
          label={<>{strings.yourName}{vm.account ? <span className={styles.number}>#{vm.account.id}</span> : null}</>}
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          autoComplete="nickname"
          maxLength={64}
          autoFocus={!vm.nickname}
        />
        <AvatarEditor value={avatar} onChange={choose} only="kinds" />
        {needsPassword ? (
          <Field
            label={<><Lock size={12} aria-hidden="true" />{strings.roomPassword}</>}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            autoFocus={Boolean(vm.nickname)}
            error={vm.error}
          />
        ) : null}
        {!needsPassword && vm.error ? <p className={styles.error} role="alert">{vm.error}</p> : null}
        <div className={styles.actions}>
          <Pill type="submit" tone="primary" size="lg" block disabled={!ready} loading={vm.busy}>{strings.join}</Pill>
          {vm.account ? null : <a className={styles.discord} href={vm.loginUrl}>{strings.withDiscord}</a>}
        </div>
      </form>
    </div>
  )
}

/** The door before the room answers: the same places, shimmering. */
export function EntrySkeleton() {
  const strings = useRoomStrings()
  return (
    <Loading label={strings.loading} className={styles.page}>
      <div className={styles.stage}>
        <Skeleton round height="auto" className={styles.heroSkeleton} />
        <div className={styles.toggles}>
          <Skeleton round width="2.25rem" height="2.25rem" />
          <Skeleton round width="2.25rem" height="2.25rem" />
        </div>
      </div>
      <div className={styles.form}>
        <div className={styles.title}>
          <Skeleton width="60%" height="1.75rem" />
          <Skeleton width="40%" height="0.9rem" />
        </div>
        <Skeleton height="2.75rem" />
        <Skeleton height="6.5rem" />
        <Skeleton round height="2.75rem" />
      </div>
    </Loading>
  )
}

/** An approval room: waiting at the door until the host lets you in. */
export function WaitingRoom({ vm }: { vm: WaitingViewModel }) {
  const strings = useRoomStrings()
  return (
    <div className={styles.page}>
      <div className={styles.waiting} role="status" aria-live="polite">
        <span className={styles.knock}>
          <Face id={vm.nickname} avatar={vm.avatar} size={88} still={false} />
        </span>
        <div className={styles.title}>
          <h1 className={styles.name}>{vm.name}</h1>
          <p className={styles.waitingLine}>{strings.waiting}</p>
        </div>
        <Pill tone="soft" size="lg" onClick={vm.cancel}>{strings.cancel}</Pill>
      </div>
    </div>
  )
}
