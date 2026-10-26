import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { RoomViewModel, ShareSource } from '../model'
import { Modal } from '../../ui/Modal'
import { Pill } from '../../ui/Pill'
import { useMediaQuery } from '../../ui/useMediaQuery'
import { RoomUiContext, useRoomUi, type RoomUi } from './context'
import { Dock } from './Dock'
import { sourceLabel } from './sources'
import { Header } from './Header'
import { gridColumns, layoutOf, type Target } from './layout'
import { SidePanel, type PanelTab } from './SidePanel'
import { useRoomStrings } from './strings'
import { PersonTile, StageTile } from './Tiles'
import styles from './RoomView.module.css'

const NARROW = '(max-width: 56rem)'

const spotlightKey = (vm: RoomViewModel) => vm.spotlight
  ? `${vm.spotlight.kind}:${'memberId' in vm.spotlight ? vm.spotlight.memberId : ''}`
  : ''

function TileFor({ target, size }: { target: Target; size: 'grid' | 'focus' | 'thumb' }) {
  const ui = useRoomUi()
  if (target.kind === 'stage') {
    const stage = ui.vm.stages.find((item) => item.id === target.id)
    return stage ? <StageTile stage={stage} size={size} /> : null
  }
  const person = ui.vm.people.find((item) => item.id === target.id)
  return person ? <PersonTile person={person} size={size} /> : null
}

/**
 * The room: header, the people or the stages, the side panel that pushes
 * them aside (a sheet from below on a phone), and the dock. Everything it
 * shows comes from `vm`; what it keeps is the viewer's own: the panel, the
 * pin, stepping out of the spotlight, the "Pessoas" view.
 */
export function RoomView({ vm }: { vm: RoomViewModel }) {
  const strings = useRoomStrings()
  const narrow = useMediaQuery(NARROW)
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia?.(NARROW).matches)
  const [tab, setTab] = useState<PanelTab>('chat')
  const [pin, setPinState] = useState<Target | null>(null)
  const [everyone, setEveryone] = useState(false)
  const [leftSpotlight, setLeftSpotlight] = useState(false)
  const [sharing, setSharing] = useState<ShareSource | null>(null)

  const lit = spotlightKey(vm)
  useEffect(() => { setLeftSpotlight(false) }, [lit])

  const setPin = (target: Target | null) => {
    setPinState(target)
    setEveryone(false)
  }

  const layout = layoutOf({ people: vm.people, stages: vm.stages, spotlight: vm.spotlight, pin, leftSpotlight, everyone })
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
  }

  const share = (source: ShareSource) => {
    vm.actions.share(source)
    setSharing(source)
  }
  const closeShare = () => setSharing(null)
  const sharePicker = sharing ? vm.slots.renderShare?.(sharing, closeShare) ?? null : null

  const waiting = vm.isHost ? vm.requests.length + vm.knocks.length : 0
  const columns = layout.kind === 'grid' ? gridColumns(layout.tiles.length, narrow) : 1

  return (
    <RoomUiContext.Provider value={ui}>
      <div className={styles.room}>
        <Header
          layout={layout}
          everyone={everyone}
          onFocus={(stageId) => {
            if (stageId === null) { setEveryone(true); return }
            setPin({ kind: 'stage', id: stageId })
          }}
          onPeople={() => {
            setTab('people')
            setPanelOpen(true)
          }}
          waiting={waiting}
        />
        <div className={styles.body} data-panel={panelOpen || undefined}>
          <div className={styles.mainColumn}>
          <main className={styles.main}>
            {layout.kind === 'grid' ? (
              <div className={styles.grid} style={{ '--columns': columns } as CSSProperties} data-count={layout.tiles.length}>
                {layout.tiles.map((target) => <TileFor key={`${target.kind}:${target.id}`} target={target} size="grid" />)}
              </div>
            ) : (
              <div className={styles.focus}>
                <div className={styles.focusMain}>
                  <TileFor target={layout.focus} size="focus" />
                  {layout.reason === 'spotlight' ? (
                    <Pill tone="glass" size="sm" className={styles.leaveSpotlight} onClick={() => setLeftSpotlight(true)}>
                      {strings.leaveSpotlight}
                    </Pill>
                  ) : null}
                </div>
                <div className={styles.column}>
                  {layout.side.map((target) => (
                    <button
                      key={`${target.kind}:${target.id}`}
                      type="button"
                      className={styles.thumb}
                      data-kind={target.kind}
                      aria-label={`${strings.pin}: ${target.kind === 'stage' ? vm.stages.find((stage) => stage.id === target.id)?.title ?? '' : ui.nameOf(target.id)}`}
                      onClick={() => setPin(target)}
                    >
                      <TileFor target={target} size="thumb" />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </main>
          <Dock
            panelOpen={panelOpen && tab === 'chat'}
            onTogglePanel={() => {
              if (panelOpen && tab === 'chat') { setPanelOpen(false); return }
              setTab('chat')
              setPanelOpen(true)
            }}
            onShare={share}
          />
          </div>
          {narrow && panelOpen ? <div className={styles.veil} onClick={() => setPanelOpen(false)} aria-hidden="true" /> : null}
          <aside className={styles.side} aria-label={strings.panel} {...(panelOpen ? {} : { inert: '' })}>
            <div className={styles.sideInner}>
              <SidePanel tab={tab} onTab={setTab} onClose={() => setPanelOpen(false)} />
            </div>
          </aside>
        </div>
      </div>
      <Modal
        open={sharePicker !== null}
        onOpenChange={(open) => { if (!open) closeShare() }}
        title={sharing ? sourceLabel(strings)[sharing] : ''}
        closeLabel={strings.close}
        wide={sharing === 'catalog'}
      >
        {sharePicker}
      </Modal>
    </RoomUiContext.Provider>
  )
}
