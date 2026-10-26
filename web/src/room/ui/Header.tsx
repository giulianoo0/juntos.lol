import { Lock, LockOpen, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { JoinMode } from '../model'
import { AvatarStack } from '../../ui/Avatar'
import { Field } from '../../ui/Field'
import { Pill } from '../../ui/Pill'
import { Segmented } from '../../ui/Segmented'
import { MorphSize } from '../../ui/MorphSize'
import { SpringPopover, SpringRow } from '../../ui/SpringPopover'
import { elapsedOf } from './chatGroups'
import { useRoomUi } from './context'
import type { Layout } from './layout'
import styles from './Header.module.css'

function useNow(stepMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), stepMs)
    return () => window.clearInterval(timer)
  }, [stepMs])
  return now
}

const accessIcon = (mode: JoinMode, size = 14) =>
  mode === 'password' ? <Lock size={size} /> : mode === 'approval' ? <ShieldCheck size={size} /> : <LockOpen size={size} />

/** "Quem pode entrar": the host picks; a password asks for itself first. */
function AccessMenu() {
  const { vm, strings } = useRoomUi()
  const [askPassword, setAskPassword] = useState(false)
  const [password, setPassword] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const labels: Record<JoinMode, string> = { open: strings.accessOpen, password: strings.accessPassword, approval: strings.accessApproval }
  const short = vm.joinMode === 'open' ? strings.accessOpenShort : labels[vm.joinMode]
  if (!vm.isHost) {
    return <span className={styles.access}>{accessIcon(vm.joinMode)}{short}</span>
  }
  return (
    <SpringPopover
      triggerRender={<Pill tone="soft" size="sm" icon={accessIcon(vm.joinMode)} />}
      trigger={<MorphSize axis="width" step={short}><span className={styles.accessText}>{short}</span></MorphSize>}
      triggerLabel={`${strings.access}: ${short}`}
      title={strings.access}
      align="end"
      initialFocus={askPassword ? field : undefined}
      onOpenChange={(open) => { if (!open) { setAskPassword(false); setPassword('') } }}
    >
      {({ close }) => <MorphSize axis="height" step={askPassword ? 'password' : 'menu'}>{askPassword ? (
        <form
          className={styles.passwordForm}
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            if (!password.trim()) return
            vm.actions.setAccess('password', password)
            close()
          }}
        >
          <Field ref={field} type="password" aria-label={strings.password} placeholder={strings.password} autoComplete="new-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} />
          <Pill type="submit" tone="primary" size="md" disabled={!password.trim()}>{strings.save}</Pill>
        </form>
      ) : (
        <div role="menu" aria-label={strings.access} className={styles.accessMenu}>
          {(['open', 'password', 'approval'] as const).map((mode) => (
            <SpringRow
              key={mode}
              icon={accessIcon(mode, 16)}
              label={labels[mode]}
              checked={vm.joinMode === mode}
              onSelect={() => {
                if (mode === 'password') { setAskPassword(true); return }
                vm.actions.setAccess(mode)
                close()
              }}
            />
          ))}
        </div>
      )}</MorphSize>}
    </SpringPopover>
  )
}

export function Header({ layout, everyone, onFocus, onPeople, waiting }: {
  layout: Layout
  everyone: boolean
  /** A stage picked in the header's switch; `null` for everyone. */
  onFocus: (stageId: string | null) => void
  onPeople: () => void
  /** Requests and knocks waiting for the host: the dot on the people pill. */
  waiting: number
}) {
  const { vm, strings } = useRoomUi()
  const now = useNow(1000)
  const focused = layout.kind === 'focus' && layout.focus.kind === 'stage' ? layout.focus.id : null
  const options = [
    ...vm.stages.map((stage) => ({ value: stage.id, label: stage.title })),
    { value: '__people', label: strings.everyone },
  ]
  return (
    <header className={styles.header}>
      <div className={styles.start}>
        <span className={styles.live} aria-hidden="true" />
        <h1 className={styles.name}>{vm.name}</h1>
        <span className={styles.clock}>{elapsedOf(now - vm.startedAt)}</span>
      </div>
      {vm.stages.length > 0 ? (
        <Segmented
          className={styles.switch}
          label={strings.focusOn}
          options={options}
          value={everyone ? '__people' : focused}
          onChange={(value) => onFocus(value === '__people' ? null : value)}
        />
      ) : null}
      <div className={styles.end}>
        <AccessMenu />
        <button type="button" className={styles.people} aria-label={strings.peopleInRoom} title={strings.peopleInRoom} onClick={onPeople}>
          <AvatarStack people={vm.people} size={24} />
          <span className={styles.count}>{vm.people.length}</span>
          {waiting > 0 ? <span className={styles.dot} aria-hidden="true" /> : null}
        </button>
      </div>
    </header>
  )
}
