import { Crown, Mic, MicOff, VideoOff, X } from 'lucide-react'
import type { Knock, StageRequest } from '../model'
import { Pill } from '../../ui/Pill'
import { Segmented } from '../../ui/Segmented'
import { SlotText } from '../../ui/SlotText'
import { Tip } from '../../ui/Tip'
import { ChatPanel } from './ChatPanel'
import { useRoomUi } from './context'
import { Face } from './Face'
import { PersonContextMenu, PersonMenu } from './PersonMenu'
import { fill } from './strings'
import styles from './SidePanel.module.css'

export type PanelTab = 'chat' | 'people'

/** A guest asking for a stage, or someone at the door: the host answers. */
function Ask({ id, avatar, line, onAnswer, allowLabel }: {
  id: string
  avatar?: string
  line: string
  allowLabel: string
  onAnswer: (allow: boolean) => void
}) {
  const { strings } = useRoomUi()
  return (
    <div className={styles.ask} role="group" aria-label={line}>
      <div className={styles.askHead}>
        <Face id={id} avatar={avatar} size={28} />
        <span className={styles.askLine}>{line}</span>
      </div>
      <div className={styles.askActions}>
        <Pill tone="soft" size="sm" block onClick={() => onAnswer(false)}>{strings.refuse}</Pill>
        <Pill tone="primary" size="sm" block onClick={() => onAnswer(true)}>{allowLabel}</Pill>
      </div>
    </div>
  )
}

function Asks({ requests, knocks }: { requests: StageRequest[]; knocks: Knock[] }) {
  const { vm, strings } = useRoomUi()
  if (!vm.isHost || requests.length + knocks.length === 0) return null
  const wants = { screen: strings.wantsScreen, media: strings.wantsMedia, live: strings.wantsLive }
  return (
    <div className={styles.asks}>
      {knocks.map((knock) => (
        <Ask
          key={knock.id}
          id={knock.id}
          line={fill(strings.knocking, { name: knock.name })}
          allowLabel={strings.admit}
          onAnswer={(allow) => (allow ? vm.actions.admit(knock.id) : vm.actions.deny(knock.id))}
        />
      ))}
      {requests.map((request) => (
        <Ask
          key={request.id}
          id={request.memberId}
          avatar={vm.people.find((person) => person.id === request.memberId)?.avatar}
          line={fill(wants[request.kind], { name: request.name })}
          allowLabel={strings.allow}
          onAnswer={(allow) => vm.actions.answerRequest(request.id, allow)}
        />
      ))}
    </div>
  )
}

function PeopleList() {
  const { vm, strings } = useRoomUi()
  return (
    <ul className={styles.people} aria-label={strings.people}>
      {vm.people.map((person) => {
        const muted = !person.mic || person.hostMuted
        const self = person.id === vm.selfId
        return (
          <PersonContextMenu key={person.id} person={person} render={<li className={styles.person} />}>
            <Face id={person.id} avatar={person.avatar} size={32} />
            <span className={styles.personName}>
              <span className={styles.nameText}>{person.name}</span>
              {person.accountId ? <span className={styles.number}>#{person.accountId}</span> : null}
              {self ? <span className={styles.you}>{strings.you}</span> : null}
              {person.host ? <Tip label={strings.host}><Crown size={13} className={styles.mark} aria-hidden="true" /></Tip> : null}
            </span>
            {person.cam && !person.hostCamOff ? null : (
              <Tip label={strings.camOff}><VideoOff size={15} className={styles.mark} aria-hidden="true" /></Tip>
            )}
            {vm.isHost && !self && !muted ? (
              <button type="button" className={styles.icon} aria-label={fill(strings.muteName, { name: person.name })} title={fill(strings.muteName, { name: person.name })} onClick={() => vm.actions.hostMute(person.id)}>
                <Mic size={15} aria-hidden="true" />
              </button>
            ) : muted ? (
              <Tip label={strings.micOff}><MicOff size={15} className={styles.mark} aria-hidden="true" /></Tip>
            ) : (
              <Tip label={strings.mic}><Mic size={15} className={styles.mark} aria-hidden="true" /></Tip>
            )}
            <PersonMenu person={person} />
          </PersonContextMenu>
        )
      })}
    </ul>
  )
}

/** The side panel: Chat | Pessoas, the host's pending answers on top. */
export function SidePanel({ tab, onTab, onClose }: { tab: PanelTab; onTab: (tab: PanelTab) => void; onClose: () => void }) {
  const { vm, strings } = useRoomUi()
  return (
    <div className={styles.panel}>
      <div className={styles.top}>
        <Segmented
          className={styles.tabs}
          label={strings.panel}
          options={[
            { value: 'chat', label: strings.chat },
            { value: 'people', label: strings.people, badge: <SlotText k={String(vm.people.length)}>{vm.people.length}</SlotText> },
          ]}
          value={tab}
          onChange={onTab}
        />
        <button type="button" className={`${styles.icon} ${styles.close}`} aria-label={strings.closePanel} title={strings.closePanel} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <Asks requests={vm.requests} knocks={vm.knocks} />
      <div key={tab} className={styles.view}>{tab === 'chat' ? <ChatPanel /> : <PeopleList />}</div>
    </div>
  )
}
