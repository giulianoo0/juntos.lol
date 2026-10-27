import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { RoomViewModel, ShareSource } from '../model'
import { Modal } from '../../ui/Modal'
import { Pill } from '../../ui/Pill'
import { focusPresence, tilePresence } from '../../ui/springMotion'
import { useMediaQuery } from '../../ui/useMediaQuery'
import { RoomUiContext, useRoomUi, type RoomUi } from './context'
import { Dock } from './Dock'
import { sourceLabel } from './sources'
import { Header } from './Header'
import { gridColumns, layoutOf, type Arrangement, type Target } from './layout'
import { PeopleContextMenu } from './PersonMenu'
import { SidePanel, type PanelTab } from './SidePanel'
import { useRoomStrings } from './strings'
import { PersonTile, StageTile } from './Tiles'
import styles from './RoomView.module.css'

const NARROW = '(max-width: 56rem)'

// The face grows with the tile it sits in.
/** In pairs, whether the item at `index` opens a row of its own: a stage
    takes a whole row, people share one two by two. */
function aloneInRow(side: readonly { kind: string }[], index: number): boolean {
  let column = 0
  for (let at = 0; at < index; at += 1) {
    column = side[at]!.kind === 'stage' ? 0 : (column + 1) % 2
  }
  return column === 0
}

const THUMB_AVATAR: Record<Arrangement, number> = { column: 88, pairs: 64, strip: 40 }

const keyOf =(target: Target) => `${target.kind}:${target.id}`

const spotlightKey = (vm: RoomViewModel) => vm.spotlight
  ? `${vm.spotlight.kind}:${'memberId' in vm.spotlight ? vm.spotlight.memberId : ''}`
  : ''

function TileFor({ target, size, avatar }: { target: Target; size: 'grid' | 'focus' | 'thumb'; avatar?: number }) {
  const ui = useRoomUi()
  if (target.kind === 'stage') {
    const stage = ui.vm.stages.find((item) => item.id === target.id)
    return stage ? <StageTile stage={stage} size={size} /> : null
  }
  const person = ui.vm.people.find((item) => item.id === target.id)
  return person ? <PersonTile person={person} size={size} avatar={avatar} /> : null
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
  const [pin, setPin] = useState<Target | null>(null)
  const [leftSpotlight, setLeftSpotlight] = useState(false)
  const [sharing, setSharing] = useState<ShareSource | null>(null)

  const lit = spotlightKey(vm)
  useEffect(() => { setLeftSpotlight(false) }, [lit])

  const reduced = useReducedMotion() ?? false
  const presence = tilePresence(reduced)
  const layout = layoutOf({ people: vm.people, stages: vm.stages, spotlight: vm.spotlight, pin, leftSpotlight, panelOpen: panelOpen && !narrow })
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
    viewProfile: vm.actions.openProfile,
  }

  const share = (source: ShareSource) => {
    vm.actions.share(source)
    setSharing(source)
  }
  const closeShare = () => setSharing(null)
  const sharePicker = sharing ? vm.slots.renderShare?.(sharing, closeShare) ?? null : null

  const waiting = vm.isHost ? vm.requests.length + vm.knocks.length : 0
  const columns = layout.kind === 'grid' ? gridColumns(layout.tiles.length, narrow) : 1
  const side = layout.kind === 'focus' ? layout.side : []
  const arrange = layout.kind === 'focus' && side.length > 0 ? layout.arrange : null
  // The right of the room holds the panel, or the people standing beside
  // the stage; Sair sits under whichever it is, as wide as it.
  const right = panelOpen && !narrow ? 'panel' : arrange === 'column' || arrange === 'pairs' ? arrange : undefined
  // Tiles move only when who is where changes, not while the panel's
  // columns slide or someone starts speaking.
  const arrangement = `${arrange}|${(layout.kind === 'grid' ? layout.tiles : side).map(keyOf).join(',')}`

  return (
    <RoomUiContext.Provider value={ui}>
      <div className={styles.room}>
        <Header
          onPeople={() => {
            setTab('people')
            setPanelOpen(true)
          }}
          waiting={waiting}
        />
        <PeopleContextMenu
          render={<div
            className={styles.body}
            data-panel={panelOpen || undefined}
            data-right={right}
            data-strip={arrange === 'strip' || undefined}
            data-mode={layout.kind}
          />}
        >
          <main className={styles.main}>
            {layout.kind === 'grid' ? (
              <div className={styles.grid} style={{ '--columns': columns } as CSSProperties} data-count={layout.tiles.length}>
                <AnimatePresence mode="popLayout" initial={false}>
                  {layout.tiles.map((target) => (
                    <motion.div key={keyOf(target)} className={styles.cell} layout layoutDependency={arrangement} {...presence}>
                      <TileFor target={target} size="grid" />
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            ) : (
              <div className={styles.focusMain}>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.div key={keyOf(layout.focus)} className={styles.focusTile} {...focusPresence(reduced)}>
                    <TileFor target={layout.focus} size="focus" />
                  </motion.div>
                </AnimatePresence>
                {layout.reason === 'spotlight' ? (
                  <Pill tone="glass" size="sm" className={styles.leaveSpotlight} onClick={() => setLeftSpotlight(true)}>
                    {strings.leaveSpotlight}
                  </Pill>
                ) : null}
              </div>
            )}
          </main>
          {arrange ? (
            // A new arrangement (the panel opening or closing, another
            // focus) is a new group born in place, not tiles flying across
            // the stage.
            <div key={`${arrange}|${layout.kind === 'focus' ? keyOf(layout.focus) : ''}`} className={styles.people} data-arrange={arrange} style={{ '--count': side.length } as CSSProperties}>
              <AnimatePresence mode="popLayout" initial={false}>
                {side.map((target, index) => (
                  <motion.button
                    key={keyOf(target)}
                    type="button"
                    className={styles.thumb}
                    data-kind={target.kind}
                    style={{ '--i': index } as CSSProperties}
                    data-wide={arrange === 'pairs' && index === side.length - 1 && aloneInRow(side, index) ? '' : undefined}
                    aria-label={`${strings.pin}: ${target.kind === 'stage' ? vm.stages.find((stage) => stage.id === target.id)?.title ?? '' : ui.nameOf(target.id)}`}
                    onClick={() => setPin(target)}
                    layout
                    layoutDependency={arrangement}
                    {...presence}
                  >
                    <TileFor target={target} size="thumb" avatar={narrow ? THUMB_AVATAR.strip : THUMB_AVATAR[arrange]} />
                  </motion.button>
                ))}
              </AnimatePresence>
            </div>
          ) : null}
          <Dock
            panelOpen={panelOpen && tab === 'chat'}
            onTogglePanel={() => {
              if (panelOpen && tab === 'chat') { setPanelOpen(false); return }
              setTab('chat')
              setPanelOpen(true)
            }}
            onShare={share}
          />
          {narrow && panelOpen ? <div className={styles.veil} onClick={() => setPanelOpen(false)} aria-hidden="true" /> : null}
          <aside className={styles.side} aria-label={strings.panel} {...(panelOpen ? {} : { inert: '' })}>
            <div className={styles.sideInner}>
              <SidePanel tab={tab} onTab={setTab} onClose={() => setPanelOpen(false)} />
            </div>
          </aside>
        </PeopleContextMenu>
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
