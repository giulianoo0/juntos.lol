import { ContextMenu } from '@base-ui/react/context-menu'
import { Crown, Ellipsis, Focus, MicOff, Pin, PinOff, UserRound, UserX, VideoOff } from 'lucide-react'
import { useRef, useState, type PointerEvent, type ReactElement, type ReactNode, type MouseEvent } from 'react'
import type { Person } from '../model'
import { SpringPopover, SpringRow, SpringRule } from '../../ui/SpringPopover'
import { springPopupClass, springPositionerClass, springRowClasses as rows } from '../../ui/springPresence'
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
      width={MENU_WIDTH}
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

const MENU_WIDTH = '15rem'

/**
 * One menu for everyone in the room, on a right click (or a long press)
 * anywhere on `render`: it opens for the person under the pointer (the
 * nearest `data-member`), springing out of it, and leaves the browser's own
 * menu everywhere else.
 */
export function PeopleContextMenu({ render, children }: {
  render: ReactElement<Record<string, unknown>>
  children: ReactNode
}) {
  const ui = useRoomUi()
  const [person, setPerson] = useState<Person | null>(null)
  const [open, setOpen] = useState(false)
  // Read in onOpenChange, which runs in the same event as the pick below.
  const picked = useRef<Person | null>(null)
  const pick = (event: MouseEvent | PointerEvent) => {
    const id = (event.target as Element).closest('[data-member]')?.getAttribute('data-member')
    picked.current = id ? ui.vm.people.find((one) => one.id === id) ?? null : null
    if (picked.current) setPerson(picked.current)
    return picked.current
  }
  return (
    <ContextMenu.Root open={open} onOpenChange={(next) => setOpen(next && picked.current !== null)}>
      <ContextMenu.Trigger
        render={render}
        onPointerDownCapture={pick}
        onContextMenuCapture={(event: MouseEvent) => { if (!pick(event)) event.stopPropagation() }}
      >
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className={springPositionerClass} collisionPadding={16}>
          <ContextMenu.Popup className={springPopupClass} style={{ width: MENU_WIDTH }} aria-label={person?.name}>
            {person ? (
              <>
                <Head person={person} />
                {actionsFor(person, ui).map((action, index) => action ? (
                  <ContextMenu.Item key={action.label} className={rows.row} data-tone={action.tone} disabled={action.disabled} onClick={action.run}>
                    <span className={rows.mark} aria-hidden="true">{action.icon}</span>
                    <span className={rows.label}>{action.label}</span>
                  </ContextMenu.Item>
                ) : <ContextMenu.Separator key={`rule-${index}`} className={rows.rule} />)}
              </>
            ) : null}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
