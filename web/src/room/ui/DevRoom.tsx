import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import type { ChatMessage, EntryViewModel, JoinMode, Person, RoomViewModel, ShareSource, Spotlight, Stage, StageRequest, Knock } from '../model'
import { Segmented } from '../../ui/Segmented'
import { useTheme, type Theme } from '../../ui/theme'
import { REACTIONS, splitReactions } from '../reactions'
import { EntryScreen, WaitingRoom } from './Entry'
import { RoomView } from './RoomView'
import styles from './DevRoom.module.css'

/* /dev/sala: the room with a fake model, to see every state without a
   server. The query sets the state, so a screenshot can ask for it:
   ?n=6&stages=media,screen&host=1&asks=1&spot=screen&view=room&theme=dark */

const NAMES = ['Giu', 'Ana', 'Bruno', 'Caio', 'Duda', 'Enzo', 'Fê', 'Gabi', 'Hugo', 'Isa', 'João', 'Lia']
// Some picked a mascot, some signed in; the rest get the default one.
const AVATARS = ['fox.bowtie', 'frog.crown', 'cat-preto.beanie', undefined, 'robot.headphones', 'panda.cap', 'mushroom', 'alien.crown', 'bee.beanie', undefined, 'owl.round-glasses', 'ghost.scarf']
const ACCOUNTS = [128, undefined, 7, undefined, undefined, 342]

// A voice that rises and falls, for the speaking faces.
const fakeLevel = () => 0.45 + 0.45 * Math.sin(performance.now() / 120) * Math.sin(performance.now() / 410)

function fakePeople(count: number): Person[] {
  return NAMES.slice(0, count).map((name, index) => ({
    id: `m-${name.toLowerCase()}`,
    name,
    host: index === 0,
    mic: index % 3 !== 2,
    cam: index % 4 === 1 || index % 4 === 3,
    speaking: index === 1 || index === 4,
    hostMuted: false,
    hostCamOff: false,
    avatar: AVATARS[index],
    accountId: ACCOUNTS[index],
  }))
}

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000

const SEED_CHAT: ChatMessage[] = [
  { id: 'c1', authorId: 'm-ana', author: 'Ana', text: 'chegou o torrent?', at: minutesAgo(6) },
  { id: 'c2', authorId: 'm-giu', author: 'Giu', text: 'tá subindo, uns 2 min', at: minutesAgo(6) },
  { id: 'c3', authorId: '', author: 'Caio', text: 'entrou', at: minutesAgo(5), system: true },
  { id: 'c4', authorId: 'm-bruno', author: 'Bruno', text: 'vou mostrar o trailer na tela enquanto isso', at: minutesAgo(5) },
  { id: 'c5', authorId: 'm-bruno', author: 'Bruno', text: 'pede aí giu', at: minutesAgo(5) },
  { id: 'c6', authorId: 'm-duda', author: 'Duda', text: 'pipoca pronta 🍿', at: minutesAgo(4) },
]

function FakeCamera({ name, hue }: { name: string; hue: number }) {
  return (
    <div className={styles.camera} style={{ background: `radial-gradient(ellipse at 50% 30%, oklch(0.55 0.08 ${hue}), oklch(0.25 0.04 ${hue}) 75%)` }} aria-label={name}>
      <svg viewBox="0 0 200 150" aria-hidden="true"><circle cx="100" cy="66" r="32" /><path d="M34 150c4-36 32-56 66-56s62 20 66 56z" /></svg>
    </div>
  )
}

function FakeStage({ stage, size }: { stage: Stage; size: 'focus' | 'thumb' }) {
  if (stage.kind === 'screen') {
    return (
      <div className={styles.screen}>
        <div className={styles.window}><span /><div><i /><i /><i /></div></div>
      </div>
    )
  }
  return (
    <div className={styles.film} data-live={stage.kind === 'live' || undefined}>
      {size === 'focus' && stage.kind === 'media' ? <p className={styles.subtitle}>Eles não vêm buscar o que é deles.</p> : null}
      {size === 'focus' ? (
        <div className={styles.bar}>
          <div className={styles.track}><span style={{ width: stage.kind === 'live' ? '100%' : '31%' }} /></div>
          <span className={styles.time}>{stage.kind === 'live' ? 'AO VIVO' : '51:20 / 2:46:00'}</span>
        </div>
      ) : null}
    </div>
  )
}

function SharePicker({ source, close }: { source: ShareSource; close: () => void }) {
  return (
    <div className={styles.picker}>
      <div className={styles.pickerList}>
        {(source === 'catalog' ? ['Duna: Parte Dois', 'Interestelar', 'Ainda Estou Aqui', 'Oppenheimer'] : ['Duna.Parte.Dois.2024.2160p.mkv', 'Extras/Trailer.mkv']).map((item) => (
          <button key={item} type="button" className={styles.pickerRow} onClick={close}>{item}</button>
        ))}
      </div>
    </div>
  )
}

const STAGE_SET: Record<string, (people: Person[]) => Stage | null> = {
  media: (people) => ({ id: 'media', kind: 'media', title: 'Duna: Parte Dois', ownerId: people[0]?.id ?? '' }),
  live: (people) => people[1] ? { id: 'live', kind: 'live', title: 'Lofi ao vivo', ownerId: people[1].id } : null,
  screen: (people) => people[2] ? { id: `screen:${people[2].id}`, kind: 'screen', title: `Tela de ${people[2].name}`, ownerId: people[2].id } : null,
}

function parseSpot(value: string | null, people: Person[]): Spotlight | null {
  if (value === 'media' || value === 'live') return { kind: value }
  if (value === 'screen' && people[2]) return { kind: 'screen', memberId: people[2].id }
  if (value === 'member' && people[1]) return { kind: 'member', memberId: people[1].id }
  return null
}

export function DevRoom() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const asked = params.get('theme')
  useEffect(() => {
    if (asked === 'light' || asked === 'dark' || asked === 'system') setTheme(asked)
    // Once per asked theme.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked])
  const count = Math.min(12, Math.max(1, Number(params.get('n') ?? 6) || 6))
  const view = params.get('view') ?? 'room'
  const isHost = params.get('host') !== '0'
  const stageKeys = (params.get('stages') ?? '').split(',').filter(Boolean)

  const [people, setPeople] = useState<Person[]>(() => fakePeople(count))
  useEffect(() => { setPeople(fakePeople(count)) }, [count])
  const [chat, setChat] = useState<ChatMessage[]>(SEED_CHAT)
  const [joinMode, setJoinMode] = useState<JoinMode>((params.get('mode') as JoinMode | null) ?? 'password')
  const [requests, setRequests] = useState<StageRequest[]>([])
  const [knocks, setKnocks] = useState<Knock[]>([])
  const [stages, setStages] = useState<Stage[]>([])
  const [spotlight, setSpotlight] = useState<Spotlight | null>(null)

  const paramsKey = params.toString()
  useEffect(() => {
    setStages(stageKeys.map((key) => STAGE_SET[key]?.(people) ?? null).filter((stage): stage is Stage => stage !== null))
    setSpotlight(parseSpot(params.get('spot'), people))
    setRequests(params.get('asks') === '1' && people[1] ? [{ id: 'r1', memberId: people[1].id, name: people[1].name, kind: 'screen' }] : [])
    setKnocks(params.get('asks') === '1' ? [{ id: 'k1', name: 'Marina' }] : [])
    // The query is the state; people only change with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey, people])

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params)
    if (value === null) next.delete(key)
    else next.set(key, value)
    setParams(next, { replace: true })
  }

  const selfId = isHost ? people[0]?.id ?? '' : people[Math.min(4, people.length - 1)]?.id ?? ''
  const update = (id: string, patch: Partial<Person>) => setPeople((list) => list.map((person) => (person.id === id ? { ...person, ...patch } : person)))

  const vm: RoomViewModel = useMemo(() => ({
    name: 'Sessão de sexta',
    link: 'juntos.lol/K7Q2M9XA',
    startedAt: Date.now() - 4_360_000,
    joinMode,
    selfId,
    isHost,
    people,
    stages,
    spotlight,
    requests,
    knocks,
    ...splitReactions(chat),
    sources: ['screen', 'file', 'torrent', 'youtube', 'drive', 'catalog'],
    levelOf: fakeLevel,
    actions: {
      setMic: (on) => update(selfId, { mic: on, hostMuted: false }),
      setCam: (on) => update(selfId, { cam: on, hostCamOff: false }),
      share: (source) => {
        if (source === 'screen') {
          const self = people.find((person) => person.id === selfId)
          if (self && !stages.some((stage) => stage.id === `screen:${selfId}`)) {
            setStages((list) => [...list, { id: `screen:${selfId}`, kind: 'screen', title: `Tela de ${self.name}`, ownerId: selfId }])
          }
        }
      },
      // As in the room: a reaction is a chat line holding only the emoji.
      react: (emoji) => {
        const self = people.find((person) => person.id === selfId)
        setChat((list) => [...list, { id: `c${Date.now()}`, authorId: selfId, author: self?.name ?? '', text: emoji, at: Date.now() }])
      },
      sendChat: (text) => {
        const self = people.find((person) => person.id === selfId)
        setChat((list) => [...list, { id: `c${Date.now()}`, authorId: selfId, author: self?.name ?? '', text, at: Date.now() }])
      },
      leave: () => toast('Sair'),
      copyLink: () => toast('Link copiado'),
      spotlight: setSpotlight,
      answerRequest: (id, allow) => {
        const request = requests.find((item) => item.id === id)
        setRequests((list) => list.filter((item) => item.id !== id))
        if (allow && request) {
          setStages((list) => [...list, { id: `screen:${request.memberId}`, kind: 'screen', title: `Tela de ${request.name}`, ownerId: request.memberId }])
        }
      },
      admit: (id) => {
        const knock = knocks.find((item) => item.id === id)
        setKnocks((list) => list.filter((item) => item.id !== id))
        if (knock) setPeople((list) => [...list, { id: `m-${knock.name.toLowerCase()}`, name: knock.name, host: false, mic: true, cam: false, speaking: false, hostMuted: false, hostCamOff: false }])
      },
      deny: (id) => setKnocks((list) => list.filter((item) => item.id !== id)),
      hostMute: (id) => update(id, { hostMuted: true, speaking: false }),
      hostCamOff: (id) => update(id, { hostCamOff: true }),
      makeHost: () => undefined,
      kick: (id) => setPeople((list) => list.filter((person) => person.id !== id)),
      setAccess: (mode) => setJoinMode(mode),
      closeStage: (stage) => setStages((list) => list.filter((item) => item.id !== stage.id)),
      openProfile: (accountId) => navigate(`/u/${accountId}`),
    },
    slots: {
      renderVideo: (memberId) => {
        const index = people.findIndex((person) => person.id === memberId)
        return <FakeCamera name={people[index]?.name ?? ''} hue={(index * 47 + 200) % 360} />
      },
      renderStage: (stage, size) => <FakeStage stage={stage} size={size} />,
      renderShare: (source, close) => (source === 'torrent' || source === 'youtube' || source === 'catalog' ? <SharePicker source={source} close={close} /> : null),
    },
    // `update` and the setters are stable enough for a dev page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [joinMode, selfId, isHost, people, stages, spotlight, requests, knocks, chat])

  const others = people.filter((person) => person.id !== selfId)
  const [entryAvatar, setEntryAvatar] = useState(params.get('avatar') ?? 'fox.bowtie')
  const entry: EntryViewModel = {
    name: 'Sessão de sexta',
    joinMode: view === 'entry-open' ? 'open' : 'password',
    present: others.slice(0, 5).map((person) => person.name),
    presentCount: others.length,
    nickname: params.get('nick') ?? 'Fê',
    mic: people.find((person) => person.id === selfId)?.mic ?? true,
    cam: people.find((person) => person.id === selfId)?.cam ?? false,
    level: fakeLevel,
    avatar: entryAvatar,
    setAvatar: setEntryAvatar,
    account: params.get('login') === '1' ? { id: 128 } : null,
    loginUrl: '/api/auth/discord?next=%2Fdev%2Fsala',
    busy: false,
    error: params.get('error') === '1' ? 'Senha errada' : undefined,
    setMic: (on) => update(selfId, { mic: on }),
    setCam: (on) => update(selfId, { cam: on }),
    join: () => set('view', 'room'),
    renderPreview: () => <FakeCamera name="Fê" hue={30} />,
  }

  // Someone else's message now and then: it appears ready, without flying.
  useEffect(() => {
    if (params.get('live') !== '1') return undefined
    const timer = window.setInterval(() => {
      setChat((list) => [...list, { id: `o${Date.now()}`, authorId: 'm-ana', author: 'Ana', text: 'olha isso', at: Date.now() }])
    }, 6000)
    return () => window.clearInterval(timer)
  }, [params])

  // ?reacts=1: the others react now and then, a few at once.
  useEffect(() => {
    if (params.get('reacts') !== '1') return undefined
    let turn = 0
    const timer = window.setInterval(() => {
      turn += 1
      const who = people[turn % people.length]
      if (!who) return
      const emoji = REACTIONS[turn % REACTIONS.length] ?? '🔥'
      setChat((list) => [...list, { id: `r${Date.now()}`, authorId: who.id, author: who.name, text: emoji, at: Date.now() }])
    }, 450)
    return () => window.clearInterval(timer)
  }, [params, people])

  return (
    <>
      {view === 'room' ? <RoomView vm={vm} />
        : view === 'waiting' ? <WaitingRoom vm={{ name: 'Sessão de sexta', nickname: 'Fê', cancel: () => set('view', 'entry') }} />
          : <EntryScreen vm={entry} />}
      {params.get('controls') === '0' ? null : (
        <details className={styles.controls}>
          <summary>dev</summary>
          <div className={styles.controlRows}>
            <Segmented label="Tela" options={[{ value: 'room', label: 'Sala' }, { value: 'entry', label: 'Entrada' }, { value: 'entry-open', label: 'Aberta' }, { value: 'waiting', label: 'Espera' }]} value={view} onChange={(value) => set('view', value)} />
            <Segmented label="Pessoas" options={['1', '2', '6', '12'].map((value) => ({ value, label: value }))} value={String(count)} onChange={(value) => set('n', value)} />
            <Segmented label="Palcos" options={[{ value: '', label: 'Nenhum' }, { value: 'media', label: 'Mídia' }, { value: 'media,screen', label: '+ Tela' }, { value: 'media,live,screen', label: '+ Live' }]} value={stageKeys.join(',')} onChange={(value) => set('stages', value || null)} />
            <Segmented label="Papel" options={[{ value: '1', label: 'Host' }, { value: '0', label: 'Convidado' }]} value={isHost ? '1' : '0'} onChange={(value) => set('host', value)} />
            <Segmented label="Pedidos" options={[{ value: '0', label: 'Sem' }, { value: '1', label: 'Com' }]} value={params.get('asks') === '1' ? '1' : '0'} onChange={(value) => set('asks', value)} />
            <Segmented label="Tema" options={[{ value: 'system', label: 'Sistema' }, { value: 'light', label: 'Claro' }, { value: 'dark', label: 'Escuro' }]} value={theme} onChange={(value) => setTheme(value as Theme)} />
          </div>
        </details>
      )}
    </>
  )
}
