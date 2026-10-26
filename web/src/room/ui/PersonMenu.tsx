import { Crown, Ellipsis, Focus, MicOff, Pin, PinOff, UserX, VideoOff } from 'lucide-react'
import type { ReactElement } from 'react'
import type { Person } from '../model'
import { SpringPopover, SpringRow, SpringRule } from '../../ui/SpringPopover'
import { sameTarget, useRoomUi } from './context'
import { fill } from './strings'
import styles from './PersonMenu.module.css'

/**
 * Someone's menu: pin for anyone; for the host also silence, camera off,
 * spotlight for everyone and remove. Opens from its "…" with the spring.
 */
export function PersonMenu({ person, trigger }: {
  person: Person
  /** The trigger element (the tile's glass circle, the list's quiet one). */
  trigger?: ReactElement<Record<string, unknown>>
}) {
  const { vm, strings, pin, setPin, spotlit } = useRoomUi()
  const target = { kind: 'person' as const, id: person.id }
  const pinned = sameTarget(pin, target)
  const lit = sameTarget(spotlit, target)
  const self = person.id === vm.selfId
  const label = fill(strings.moreFor, { name: person.name })
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
          <SpringRow
            icon={pinned ? <PinOff size={16} /> : <Pin size={16} />}
            label={pinned ? strings.unpin : strings.pin}
            onSelect={() => { setPin(pinned ? null : target); close() }}
          />
          {vm.isHost ? (
            <>
              <SpringRow
                icon={<Focus size={16} />}
                label={lit ? strings.spotlightOff : strings.spotlightAll}
                onSelect={() => { vm.actions.spotlight(lit ? null : { kind: 'member', memberId: person.id }); close() }}
              />
              {!self ? (
                <>
                  <SpringRule />
                  <SpringRow
                    icon={<MicOff size={16} />}
                    label={strings.mute}
                    disabled={!person.mic || person.hostMuted}
                    onSelect={() => { vm.actions.hostMute(person.id); close() }}
                  />
                  <SpringRow
                    icon={<VideoOff size={16} />}
                    label={strings.camOffForce}
                    disabled={!person.cam || person.hostCamOff}
                    onSelect={() => { vm.actions.hostCamOff(person.id); close() }}
                  />
                  <SpringRule />
                  <SpringRow icon={<Crown size={16} />} label={strings.makeHost} onSelect={() => { vm.actions.makeHost(person.id); close() }} />
                  <SpringRow icon={<UserX size={16} />} label={strings.kick} tone="danger" onSelect={() => { vm.actions.kick(person.id); close() }} />
                </>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </SpringPopover>
  )
}
