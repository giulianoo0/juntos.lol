import { MessageSquare, SlidersHorizontal } from 'lucide-react'
import { useMemo, useState, type CSSProperties } from 'react'
import { useT } from '../i18n/useT'
import type { RoomViewModel } from '../room/model'
import { ChatPanel } from '../room/ui/ChatPanel'
import { RoomUiContext, type RoomUi } from '../room/ui/context'
import { FaceStack } from '../room/ui/Face'
import { layoutOf, type Target } from '../room/ui/layout'
import { useRoomStrings } from '../room/ui/strings'
import { PersonTile, StageTile } from '../room/ui/Tiles'
import styles from './tv.module.css'

const keyOf = (target: Target) => `${target.kind}:${target.id}`

function TileFor({ vm, target, size }: { vm: RoomViewModel; target: Target; size: 'grid' | 'focus' | 'thumb' }) {
  if (target.kind === 'stage') {
    const stage = vm.stages.find((item) => item.id === target.id)
    return stage ? <StageTile stage={stage} size={size} /> : null
  }
  const person = vm.people.find((item) => item.id === target.id)
  return person ? <PersonTile person={person} size={size} avatar={size === 'thumb' ? 56 : undefined} /> : null
}

/**
 * The room as a TV shows it: the stage big, the people in a row under it,
 * the chat to read beside it. Nothing to send from here: no dock, no
 * composer, no host's menus. What the viewer keeps is the pin.
 */
export function TvRoomView({ vm, onAudio }: { vm: RoomViewModel; onAudio: () => void }) {
  const t = useT()
  const strings = useRoomStrings()
  const [chatOpen, setChatOpen] = useState(true)
  const [pin, setPin] = useState<Target | null>(null)
  const [leftSpotlight, setLeftSpotlight] = useState(false)
  const layout = layoutOf({ people: vm.people, stages: vm.stages, spotlight: vm.spotlight, pin, leftSpotlight, panelOpen: true })
  const spotlit = useMemo<Target | null>(() => {
    const spot = vm.spotlight
    if (!spot) return null
    if (spot.kind === 'member') return { kind: 'person', id: spot.memberId }
    if (spot.kind === 'screen') return { kind: 'stage', id: `screen:${spot.memberId}` }
    return { kind: 'stage', id: spot.kind }
  }, [vm.spotlight])

  const ui: RoomUi = {
    vm,
    strings,
    pin,
    setPin,
    leftSpotlight,
    setLeftSpotlight,
    spotlit,
    nameOf: (memberId) => vm.people.find((person) => person.id === memberId)?.name ?? '',
    viewProfile: () => undefined,
  }
  const side = layout.kind === 'focus' ? layout.side : []

  return (
    <RoomUiContext.Provider value={ui}>
      <div className={styles.room} data-chat={chatOpen || undefined}>
        <header className={styles.roomHeader}>
          <h1 className={styles.roomName}>{vm.name}</h1>
          <FaceStack people={vm.people.map((person) => ({ id: person.id, avatar: person.avatar }))} size={36} max={4} />
          <span className={styles.roomCount}>{vm.people.length}</span>
          <span className={styles.spacer} />
          <button type="button" className={styles.roundButton} aria-label={strings.chat} title={strings.chat} aria-pressed={chatOpen} onClick={() => setChatOpen((open) => !open)}>
            <MessageSquare size={22} aria-hidden="true" />
          </button>
          <button type="button" className={styles.roundButton} aria-label={t('tv.audio')} title={t('tv.audio')} onClick={onAudio}>
            <SlidersHorizontal size={22} aria-hidden="true" />
          </button>
        </header>
        <main className={styles.roomMain} data-mode={layout.kind}>
          {layout.kind === 'grid' ? (
            <div className={styles.grid} style={{ '--columns': Math.min(Math.ceil(Math.sqrt(layout.tiles.length)), 4) } as CSSProperties}>
              {layout.tiles.map((target) => (
                <div key={keyOf(target)} className={styles.cell}><TileFor vm={vm} target={target} size="grid" /></div>
              ))}
            </div>
          ) : (
            <>
              <div key={keyOf(layout.focus)} className={styles.focus}><TileFor vm={vm} target={layout.focus} size="focus" /></div>
              {side.length > 0 ? (
                <div className={styles.strip}>
                  {side.map((target) => (
                    <button key={keyOf(target)} type="button" className={styles.thumb} aria-label={`${strings.pin}: ${target.kind === 'stage' ? vm.stages.find((stage) => stage.id === target.id)?.title ?? '' : ui.nameOf(target.id)}`} onClick={() => setPin(target)}>
                      <TileFor vm={vm} target={target} size="thumb" />
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          )}
        </main>
        {chatOpen ? (
          <aside className={styles.chat} aria-label={strings.chat}>
            <ChatPanel readOnly />
          </aside>
        ) : null}
      </div>
    </RoomUiContext.Provider>
  )
}
