import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { CallProvider, CallVideo } from '../call/CallVideo'
import { useCall } from '../call/useCall'
import { StillThere } from '../components/StillThere'
import { useT } from '../i18n/useT'
import { Player } from '../player/Player'
import { useSync } from '../player/useSync'
import type { ChatMessage as ViewChatMessage, Person, RoomActions, RoomViewModel, Stage as ViewStage } from '../room/model'
import { splitReactions } from '../room/reactions'
import { useStageHosts } from '../room/stageHosts'
import { canDriveMedia, currentSpotlight, stagesOf } from '../room/stages'
import { useRoomStrings } from '../room/ui/strings'
import { emptyRoom, useLiveRoom } from '../room/useLiveRoom'
import type { ChatEntry } from '../types'
import { Loading, Skeleton } from '../ui/Shimmer'
import type { TvAccount } from './api'
import { AudioPanel } from './AudioPanel'
import { playerKeyFor } from './keys'
import { memberVolumes, ownerMemberId, type Mix } from './mix'
import { TvRelayStage } from './TvRelayStage'
import { TvRoomView } from './TvRoomView'
import type { MediaAction } from './useRemote'
import styles from './tv.module.css'

/** What the remote asks of the room while the TV is in one. */
export interface RoomRemote {
  /** True when Back closed something of the room's (the audio panel). */
  back(): boolean
  menu(): void
  media(action: MediaAction): void
}

const nothing = () => undefined
// The TV sends nothing to the room but what plays: no mic, no camera, no host's tools.
const READ_ONLY_ACTIONS: RoomActions = {
  setMic: nothing, setCam: nothing, share: nothing, react: nothing, sendChat: nothing, leave: nothing, copyLink: nothing,
  spotlight: nothing, answerRequest: nothing, admit: nothing, deny: nothing, hostMute: nothing, hostCamOff: nothing,
  kick: nothing, unban: nothing, makeHost: nothing, setAccess: nothing, closeStage: nothing, openProfile: nothing,
}

/**
 * A room mirrored on the TV: the same socket, player, live, screens and
 * call a browser has, joined with the TV's token and the cast's ticket, and
 * none of what prepares media. It hands the room back (`onClosed`) when the
 * room lets it go.
 */
export function TvRoom({ roomId, ticket, token, account, mix, onMix, onClosed, remoteRef }: {
  roomId: string
  ticket: string
  token: string
  account: TvAccount
  mix: Mix
  onMix: (mix: Mix) => void
  onClosed: () => void
  remoteRef: RefObject<RoomRemote | null>
}) {
  const t = useT()
  const strings = useRoomStrings()
  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaOffsetMsRef = useRef(0)
  const playerSeekRef = useRef<((seconds: number) => void) | null>(null)
  const coldWaitRef = useRef(false)
  const coldForRef = useRef<((ms: number) => boolean) | null>(null)
  const remoteSteerAtRef = useRef(0)
  const seat = useMemo(() => ({ token, ticket }), [token, ticket])
  const sync = useSync(roomId, account.nickname, videoRef, mediaOffsetMsRef, coldWaitRef, remoteSteerAtRef, coldForRef, seat)
  const initial = useMemo(() => emptyRoom(roomId), [roomId])
  const [liveRoom] = useLiveRoom(initial, sync)
  if (!liveRoom.mediaRegions || liveRoom.mediaRegions.length === 0) mediaOffsetMsRef.current = liveRoom.mediaOffsetMs ?? 0

  // Put out, gone, closed for idling or turned away at the door: back to waiting.
  const closed = sync.kicked || sync.replaced || sync.gone || sync.left || sync.door === 'denied' || sync.door === 'password' || sync.door === 'badPassword'
  useEffect(() => {
    if (!closed) return
    videoRef.current?.pause()
    onClosed()
  }, [closed, onClosed])

  const ownerId = ownerMemberId(sync.members, account.id)
  const stageRoom = useMemo(() => ({ ...liveRoom, controllerId: sync.controllerId || liveRoom.controllerId }), [liveRoom, sync.controllerId])
  // The TV drives what its account may drive.
  const canDrive = canDriveMedia(stageRoom, sync.memberId) || (ownerId !== null && canDriveMedia(stageRoom, ownerId))
  const memberIds = sync.members.map((member) => member.id).join(',')
  const volumes = useMemo(() => memberVolumes(mix, memberIds ? memberIds.split(',') : [], ownerId), [mix, memberIds, ownerId])

  const call = useCall({
    roomId,
    memberId: sync.memberId,
    capability: sync.capability,
    send: nothing,
    members: sync.members,
    relayEpoch: liveRoom.relayEpoch,
    volumes,
  })

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const apply = () => { video.volume = mix.media }
    apply()
    video.addEventListener('loadedmetadata', apply)
    return () => video.removeEventListener('loadedmetadata', apply)
  })

  const [audioOpen, setAudioOpen] = useState(false)
  const roomStages = stagesOf(stageRoom)
  const mediaStage = roomStages.find((stage) => stage.kind === 'media')
  useEffect(() => {
    remoteRef.current = {
      back: () => {
        if (!audioOpen) return false
        setAudioOpen(false)
        return true
      },
      menu: () => setAudioOpen((open) => !open),
      media: (action) => {
        const video = videoRef.current
        if (!video || !mediaStage) return
        const key = playerKeyFor(action, video.paused)
        if (key) document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      },
    }
    return () => { remoteRef.current = null }
  })

  const people: Person[] = sync.members.map((member) => ({
    id: member.id,
    name: member.nickname,
    host: member.id === sync.controllerId,
    mic: Boolean(member.mic),
    cam: Boolean(member.cam),
    speaking: Boolean(call.speaking[member.id]),
    hostMuted: Boolean(member.hostMuted),
    hostCamOff: Boolean(member.hostCamOff),
    accountId: member.accountId || undefined,
    avatar: member.avatar || undefined,
    app: member.client === 'desktop',
  }))
  const viewStages: ViewStage[] = roomStages.map((stage) => ({
    id: stage.id,
    kind: stage.kind,
    title: stage.kind === 'screen' ? strings.screenOf.replace('{name}', stage.title) : stage.kind === 'live' ? stage.title || t('stage.kind.live') : liveRoom.fileName || t('stage.kind.media'),
    ownerId: stage.ownerId ?? '',
  }))
  const chatEntries = useMemo((): ChatEntry[] => [
    ...sync.messages,
    ...sync.presence.map((event) => ({ author: event.nickname, text: t(event.kind === 'join' ? 'presence.joined' : 'presence.left'), at: event.at, system: true })),
  ].sort((left, right) => Date.parse(left.at) - Date.parse(right.at)), [sync.messages, sync.presence, t])
  const memberIdByName = new Map(sync.members.map((member) => [member.nickname, member.id]))
  const { chat, reactions: serverReactions } = splitReactions(chatEntries.map((entry, index): ViewChatMessage => ({
    id: `${entry.at}:${index}`,
    authorId: entry.system ? '' : memberIdByName.get(entry.author) ?? entry.author,
    author: entry.author,
    text: entry.text,
    at: Date.parse(entry.at),
    system: entry.system,
  })))
  const reactions = serverReactions.map((reaction) => ({ ...reaction, at: reaction.at - sync.serverOffsetMs }))
  const hosts = useStageHosts()

  const vm: RoomViewModel = {
    name: liveRoom.name || liveRoom.fileName || t('room.screenLabel'),
    link: '',
    startedAt: liveRoom.createdAt ? Date.parse(liveRoom.createdAt) : Date.now(),
    joinMode: liveRoom.joinMode ?? 'open',
    selfId: sync.memberId,
    isHost: false,
    people,
    stages: viewStages,
    spotlight: currentSpotlight(stageRoom, sync.stages) as RoomViewModel['spotlight'],
    requests: [],
    knocks: [],
    removed: [],
    chat,
    reactions,
    sources: [],
    levelOf: call.levelOf,
    actions: READ_ONLY_ACTIONS,
    slots: {
      renderVideo: (memberId) => <CallVideo memberId={memberId} />,
      renderStage: (stage) => hosts.slot(stage.id),
    },
  }

  const status = sync.roomStatus === 'ready' || sync.roomStatus === 'error' ? sync.roomStatus : liveRoom.status
  const mediaContent = mediaStage ? (
    <div className="stage-media">
      {status === 'ready' ? (
        <Player
          room={liveRoom}
          isController={canDrive}
          memberId={sync.memberId}
          capability={sync.capability}
          hostSubtitles={sync.hostSubtitles}
          videoRef={videoRef}
          send={sync.send}
          t={t}
          syncState={sync.state}
          serverOffsetMs={sync.serverOffsetMs}
          mediaOffsetMsRef={mediaOffsetMsRef}
          seekRef={playerSeekRef}
          coldWaitRef={coldWaitRef}
          coldForRef={coldForRef}
          remoteSteerAtRef={remoteSteerAtRef}
          autoplayBlocked={sync.autoplayBlocked}
          gatedStart={sync.waiting !== null}
          onBuffering={sync.reportBuffering}
        />
      ) : status === 'error' ? (
        <div className={styles.stageNote} role="alert">{t('room.error')}</div>
      ) : (
        <Loading label={t('status.loading')} className={styles.relayWaiting}>
          <Skeleton width="100%" height="100%" />
        </Loading>
      )}
    </div>
  ) : null

  return (
    <CallProvider call={call}>
      <TvRoomView vm={vm} onAudio={() => setAudioOpen(true)} />
      {mediaStage ? hosts.portal('media', mediaContent) : null}
      {liveRoom.live ? hosts.portal('live', (
        <TvRelayStage
          roomId={roomId}
          memberId={sync.memberId}
          capability={sync.capability}
          relayEpoch={liveRoom.relayEpoch}
          source={{ kind: 'live', broadcast: liveRoom.live.broadcast }}
          title={liveRoom.live.title}
          volume={mix.media}
        />
      )) : null}
      {roomStages.filter((stage) => stage.kind === 'screen').map((stage) => hosts.portal(stage.id, (
        <TvRelayStage
          roomId={roomId}
          memberId={sync.memberId}
          capability={sync.capability}
          relayEpoch={liveRoom.relayEpoch}
          source={{ kind: 'screen', ownerId: stage.ownerId ?? '' }}
          title={strings.screenOf.replace('{name}', stage.title)}
          volume={mix.media}
        />
      )))}
      {audioOpen ? (
        <AudioPanel
          mix={mix}
          people={people.map((person) => ({ id: person.id, name: person.name, avatar: person.avatar }))}
          ownerId={ownerId}
          onChange={onMix}
          onClose={() => setAudioOpen(false)}
        />
      ) : null}
      <StillThere
        deadlineMs={sync.stillThereDeadlineMs}
        serverOffsetMs={sync.serverOffsetMs}
        onStay={() => sync.send('stillHere')}
        onExpired={onClosed}
        t={t}
      />
    </CallProvider>
  )
}
