import { Lock, Mic, MicOff, Video, VideoOff } from 'lucide-react'
import { useState, type CSSProperties, type FormEvent } from 'react'
import type { EntryViewModel, WaitingViewModel } from '../model'
import { Avatar, AvatarStack } from '../../ui/Avatar'
import { Field } from '../../ui/Field'
import { IconPill } from '../../ui/IconPill'
import { Pill } from '../../ui/Pill'
import { presentLine, useRoomStrings } from './strings'
import styles from './Entry.module.css'

function Silhouette() {
  return (
    <svg className={styles.silhouette} viewBox="0 0 200 150" aria-hidden="true">
      <circle cx="100" cy="62" r="34" fill="currentColor" />
      <path d="M30 150c4-38 34-58 70-58s66 20 70 58z" fill="currentColor" />
    </svg>
  )
}

/** Before the room: your camera, your name and, when asked, the password. */
export function EntryScreen({ vm }: { vm: EntryViewModel }) {
  const strings = useRoomStrings()
  const [nickname, setNickname] = useState(vm.nickname)
  const [password, setPassword] = useState('')
  const needsPassword = vm.joinMode === 'password'
  const ready = (!needsPassword || password !== '') && !vm.busy
  const present = vm.present.map((name, index) => ({ id: `${index}:${name}`, name }))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (ready) vm.join({ nickname: nickname.trim(), password })
  }

  return (
    <div className={styles.page}>
      <div className={styles.preview}>
        {vm.cam ? <div className={styles.video}>{vm.renderPreview()}</div> : <Silhouette />}
        {vm.mic && vm.micLabel ? (
          <div className={styles.micTag}>
            <span className={styles.meter} style={{ '--level': vm.micLevel ?? 0 } as CSSProperties} aria-hidden="true">
              <span /><span /><span />
            </span>
            {vm.micLabel}
          </div>
        ) : null}
        <div className={styles.toggles}>
          <IconPill flow tone="scrim" label={vm.mic ? strings.mic : strings.micOff} icon={vm.mic ? <Mic size={18} /> : <MicOff size={18} />} state={vm.mic ? undefined : 'off'} aria-pressed={vm.mic} onClick={() => vm.setMic(!vm.mic)} />
          <IconPill flow tone="scrim" label={vm.cam ? strings.cam : strings.camOff} icon={vm.cam ? <Video size={18} /> : <VideoOff size={18} />} state={vm.cam ? undefined : 'off'} aria-pressed={vm.cam} onClick={() => vm.setCam(!vm.cam)} />
        </div>
      </div>

      <form className={styles.form} onSubmit={submit}>
        <div className={styles.title}>
          <h1 className={styles.name}>{vm.name}</h1>
          <div className={styles.present}>
            {present.length > 0 ? <AvatarStack people={present} size={22} /> : null}
            <span>{presentLine(strings, vm.present, vm.presentCount)}</span>
          </div>
        </div>
        <Field
          label={strings.yourName}
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          autoComplete="nickname"
          maxLength={64}
          autoFocus={!vm.nickname}
        />
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
        <Pill type="submit" tone="primary" size="lg" block disabled={!ready}>{strings.join}</Pill>
      </form>
    </div>
  )
}

/** An approval room: waiting at the door until the host lets you in. */
export function WaitingRoom({ vm }: { vm: WaitingViewModel }) {
  const strings = useRoomStrings()
  return (
    <div className={styles.page}>
      <div className={styles.waiting} role="status" aria-live="polite">
        <span className={styles.knock}>
          <Avatar id={vm.nickname} name={vm.nickname} size={72} />
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
