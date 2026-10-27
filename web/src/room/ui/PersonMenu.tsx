import { ContextMenu } from '@base-ui/react/context-menu'
import { Crown, Ellipsis, Focus, MicOff, Pin, PinOff, UserRound, UserX, VideoOff } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'
import type { Person } from '../model'
import { SpringPopover, SpringRow, SpringRule } from '../../ui/SpringPopover'
import popover from '../../ui/SpringPopover.module.css'
import { sameTarget, useRoomUi, type RoomUi } from './context'
import { Face } from './Face'
import { fill } from './strings'
import styles from './PersonMenu.module.css'

interface Action {
  icon: ReactNode
  label: string
  tone?: 'danger'
  disabled?: boolean
  run: () => void
}

/** What can be done to someone, in order, `null` between groups: their
    profile and the pin for anyone; for the host also spotlight, silence,
    camera off, host and remove. */
function actionsFor(person: Person, { vm, strings, pin, setPin, spotlit, viewProfile }: RoomUi): Array<Action | null> {
  const target = { kind: 'person' as const, id: person.id }
  const pinned = sameTarget(pin, target)
  const lit = sameTarget(spotlit, target)
  const self = person.id === vm.selfId
  const { accountId } = person
  const actions: Array<Action | null> = []
  if (accountId) actions.push({ icon: <UserRound size={16} />, label: strings.viewProfile, run: () => viewProfile(accountId) })
  actions.push({ icon: pinned ? <PinOff size={16} /> : <Pin size={16} />, label: pinned ? strings.unpin : strings.pin, run: () => setPin(pinned ? null : target) })
  if (!vm.isHost) return actions
  actions.push({
    icon: <Focus size={16} />,
    label: lit ? strings.spotlightOff : strings.spotlightAll,
    run: () => vm.actions.spotlight(lit ? null : { kind: 'member', memberId: person.id }),
  })
  if (self) return actions
  actions.push(
    null,
    { icon: <MicOff size={16} />, label: strings.mute, disabled: !person.mic || person.hostMuted, run: () => vm.actions.hostMute(person.id) },
    { icon: <VideoOff size={16} />, label: strings.camOffForce, disabled: !person.cam || person.hostCamOff, run: () => vm.actions.hostCamOff(person.id) },
    null,
    { icon: <Crown size={16} />, label: strings.makeHost, run: () => vm.actions.makeHost(person.id) },
    { icon: <UserX size={16} />, label: strings.kick, tone: 'danger', run: () => vm.actions.kick(person.id) },
  )
  return actions
}

function Head({ person }: { person: Person }) {
  return (
    <div className={styles.head} aria-hidden="true">
      <Face id={person.id} avatar={person.avatar} size={30} />
      <span className={styles.headName}>{person.name}</span>
      {person.accountId ? <span className={styles.number}>#{person.accountId}</span> : null}
    </div>
  )
}

/** Someone's menu, opened from its "…" with the spring. */
export function PersonMenu({ person, trigger }: {
  person: Person
  /** The trigger element (the tile's glass circle, the list's quiet one). */
  trigger?: ReactElement<Record<string, unknown>>
}) {
  const ui = useRoomUi()
  const label = fill(ui.strings.moreFor, { name: person.name })
  return (
    <SpringPopover
      triggerRender={trigger ?? <button type="button" className={styles.trigger} aria-label={label} title={label} />}
      triggerLabel={label}
      trigger={<Ellipsis size={15} aria-hidden="true" />}
      align="end"
      width="15rem"
    >
      {({ close }) => (
        <div role="menu" aria-label={person.name}>
          <Head person={person} />
          {actionsFor(person, ui).map((action, index) => action ? (
            <SpringRow key={action.label} icon={action.icon} label={action.label} tone={action.tone} disabled={action.disabled} onSelect={() => { action.run(); close() }} />
          ) : <SpringRule key={`rule-${index}`} />)}
        </div>
      )}
    </SpringPopover>
  )
}

function ContextRows({ person }: { person: Person }) {
  const ui = useRoomUi()
  return actionsFor(person, ui).map((action, index) => action ? (
    <ContextMenu.Item key={action.label} className={popover.row} data-tone={action.tone} disabled={action.disabled} onClick={action.run}>
      <span className={popover.mark} aria-hidden="true">{action.icon}</span>
      <span className={popover.label}>{action.label}</span>
    </ContextMenu.Item>
  ) : <ContextMenu.Separator key={`rule-${index}`} className={popover.rule} />)
}

/** The same menu on a right click (or a long press) anywhere on `render`,
    springing out of the pointer. */
export function PersonContextMenu({ person, render, children }: {
  person: Person
  render: ReactElement<Record<string, unknown>>
  children: ReactNode
}) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={render}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className={popover.positioner} collisionPadding={16}>
          <ContextMenu.Popup className={popover.popup} style={{ width: '15rem' }} aria-label={person.name}>
            <Head person={person} />
            <ContextRows person={person} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
