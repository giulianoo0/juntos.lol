import { Link, LogOut, MessageSquare, Mic, MicOff, MonitorUp, Smile, Video, VideoOff } from 'lucide-react'
import type { ShareSource } from '../model'
import { IconPill } from '../../ui/IconPill'
import { Pill } from '../../ui/Pill'
import { SpringPopover, SpringRow } from '../../ui/SpringPopover'
import { useRoomUi } from './context'
import { sourceIcon, sourceLabel } from './sources'
import styles from './Dock.module.css'

const REACTIONS = ['👏', '😂', '😮', '❤️', '🔥', '🍿']

/** The dock: the room's link, then mic, camera, Compartilhar, reactions
    and the chat in the middle; and Sair, apart, under the room's right
    column (the room's grid places both). */
export function Dock({ panelOpen, onTogglePanel, onShare }: {
  panelOpen: boolean
  onTogglePanel: () => void
  onShare: (source: ShareSource) => void
}) {
  const { vm, strings } = useRoomUi()
  const self = vm.people.find((person) => person.id === vm.selfId)
  const mic = Boolean(self?.mic && !self.hostMuted)
  const cam = Boolean(self?.cam && !self.hostCamOff)
  const labels = sourceLabel(strings)
  return (
    <>
      <footer className={styles.dock}>
        <Pill tone="soft" size="md" className={styles.link} icon={<Link size={14} />} aria-label={strings.copyLink} title={strings.copyLink} onClick={vm.actions.copyLink}>
          <span className={styles.linkText}>{vm.link}</span>
        </Pill>
  
        <div className={styles.center}>
          <IconPill flow label={mic ? strings.mic : strings.micOff} icon={mic ? <Mic size={18} /> : <MicOff size={18} />} state={mic ? undefined : 'off'} aria-pressed={mic} onClick={() => vm.actions.setMic(!mic)} />
          <IconPill flow label={cam ? strings.cam : strings.camOff} icon={cam ? <Video size={18} /> : <VideoOff size={18} />} state={cam ? undefined : 'off'} aria-pressed={cam} onClick={() => vm.actions.setCam(!cam)} />
          <SpringPopover
            triggerRender={<Pill tone="primary" size="lg" className={styles.share} icon={<MonitorUp size={17} />} />}
            trigger={<span className={styles.shareText}>{strings.share}</span>}
            triggerLabel={strings.share}
            title={strings.shareTitle}
            side="top"
            align="center"
            width="18.75rem"
          >
            {({ close }) => (
              <div role="menu" aria-label={strings.shareTitle}>
                {vm.sources.map((source) => (
                  <SpringRow key={source} icon={sourceIcon[source]} label={labels[source]} onSelect={() => { close(); onShare(source) }} />
                ))}
              </div>
            )}
          </SpringPopover>
          <SpringPopover
            triggerRender={<IconPill flow label={strings.reactions} icon={<Smile size={18} />} />}
            triggerLabel={strings.reactions}
            side="top"
            align="center"
            width="auto"
          >
            {({ close }) => (
              <div className={styles.reactions} role="menu" aria-label={strings.reactions}>
                {REACTIONS.map((emoji) => (
                  <button key={emoji} type="button" role="menuitem" className={styles.reaction} onClick={() => { vm.actions.react(emoji); close() }}>
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </SpringPopover>
          <IconPill flow label={strings.chat} icon={<MessageSquare size={18} />} active={panelOpen} aria-expanded={panelOpen} onClick={onTogglePanel} />
        </div>
      </footer>
      <div className={styles.leaveCell}>
        <Pill tone="danger" size="lg" className={styles.leave} aria-label={strings.leave} onClick={vm.actions.leave}>
          <LogOut size={16} className={styles.leaveIcon} aria-hidden="true" />
          <span className={styles.leaveText}>{strings.leave}</span>
        </Pill>
      </div>
    </>
  )
}
