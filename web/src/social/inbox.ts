/**
 * The signed-in account's live side: one socket to /ws/inbox carrying private
 * messages, read receipts, typing and the nudges that friends, presence or
 * invites changed. It reconnects by itself and, each time, fetches what came
 * while it was away, so nothing depends on the socket never dropping.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { refreshNotifications } from '../account/notifications'
import {
  deriveWrapKey,
  forgetDevice,
  generateDeviceKeys,
  loadDevice,
  open,
  randomBytes,
  saveDevice,
  seal,
  toBase64Url,
  type StoredDevice,
} from './crypto'

export interface ServerDevice { id: string; accountId: number; publicKey: string; label?: string }

interface WireMessage {
  id: number
  from: number
  to: number
  senderDevice: string
  clientId: string
  iv: string
  body: string
  key?: { iv: string; key: string }
  at: string
}

export type MessageState = 'sent' | 'sending' | 'failed'

export interface ChatMessage {
  /** The server's id; 0 while sending. */
  id: number
  clientId: string
  from: number
  to: number
  at: string
  /** null when this device cannot open it (sent before it existed). */
  text: string | null
  state: MessageState
}

export interface Thread {
  friendId: number
  /** Oldest first. */
  messages: ChatMessage[]
  loaded: boolean
  loading: boolean
  more: boolean
  unread: number
  theyRead: number
  typingUntil: number
}

export interface InboxState {
  status: 'off' | 'connecting' | 'live' | 'unsupported'
  me: number | null
  threads: Record<number, Thread>
  /** Bumped when friends or their presence change. */
  friendsVersion: number
}

const empty: InboxState = { status: 'off', me: null, threads: {}, friendsVersion: 0 }
let state: InboxState = empty
const listeners = new Set<() => void>()

function publish(next: InboxState) {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function thread(friendId: number): Thread {
  return state.threads[friendId] ?? {
    friendId, messages: [], loaded: false, loading: false, more: false, unread: 0, theyRead: 0, typingUntil: 0,
  }
}

function patchThread(friendId: number, change: (t: Thread) => Thread) {
  publish({ ...state, threads: { ...state.threads, [friendId]: change(thread(friendId)) } })
}

const json = { 'Content-Type': 'application/json' }

// The device, its key cache, the socket and what was seen last.
let device: StoredDevice | null = null
let socket: WebSocket | null = null
let retry = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let lastSeen = 0
let generation = 0
const publicKeys = new Map<string, string>()
const wrapKeys = new Map<string, Promise<CryptoKey>>()
const pairDevices = new Map<number, { mine: ServerDevice[]; theirs: ServerDevice[] }>()

function remember(devices: ServerDevice[]) {
  for (const each of devices) publicKeys.set(each.id, each.publicKey)
}

function wrapKeyFor(deviceId: string, publicKey: string): Promise<CryptoKey> {
  const cached = wrapKeys.get(deviceId)
  if (cached) return cached
  const derived = deriveWrapKey(device!.privateKey, device!.deviceId, publicKey, deviceId)
  wrapKeys.set(deviceId, derived)
  derived.catch(() => wrapKeys.delete(deviceId))
  return derived
}

async function registerDevice(accountId: number): Promise<StoredDevice> {
  const stored = await loadDevice(accountId).catch(() => null)
  const keys = stored ?? { ...(await generateDeviceKeys()), accountId, deviceId: '' }
  const response = await fetch('/api/dm/devices', {
    method: 'POST', headers: json, body: JSON.stringify({ publicKey: keys.publicKey, label: deviceLabel() }),
  })
  if (!response.ok) throw new Error(`device ${response.status}`)
  const registered = await response.json() as ServerDevice
  const next: StoredDevice = { accountId, deviceId: registered.id, privateKey: keys.privateKey, publicKey: keys.publicKey }
  if (!stored || stored.deviceId !== registered.id) await saveDevice(next)
  return next
}

function deviceLabel(): string {
  const ua = navigator.userAgent
  if (/Android/.test(ua)) return 'Android'
  if (/iPhone|iPad/.test(ua)) return 'iPhone'
  if (/Macintosh/.test(ua)) return 'Mac'
  if (/Windows/.test(ua)) return 'Windows'
  return 'Navegador'
}

async function keysWith(friendId: number, fresh = false) {
  const known = pairDevices.get(friendId)
  if (known && !fresh) return known
  const response = await fetch(`/api/dm/with/${friendId}/keys`)
  if (!response.ok) throw new Error(`keys ${response.status}`)
  const devices = await response.json() as { mine: ServerDevice[]; theirs: ServerDevice[] }
  remember(devices.mine)
  remember(devices.theirs)
  pairDevices.set(friendId, devices)
  return devices
}

async function decrypt(wire: WireMessage): Promise<ChatMessage> {
  const base = { id: wire.id, clientId: wire.clientId, from: wire.from, to: wire.to, at: wire.at, state: 'sent' as const }
  if (!wire.key || !device) return { ...base, text: null }
  let senderKey = publicKeys.get(wire.senderDevice)
  if (!senderKey) {
    const other = wire.from === state.me ? wire.to : wire.from
    await keysWith(other, true).catch(() => undefined)
    senderKey = publicKeys.get(wire.senderDevice)
  }
  if (!senderKey) return { ...base, text: null }
  try {
    return { ...base, text: await open(wire, wire.key, await wrapKeyFor(wire.senderDevice, senderKey)) }
  } catch {
    return { ...base, text: null }
  }
}

function otherOf(message: { from: number; to: number }): number {
  return message.from === state.me ? message.to : message.from
}

/** Puts a message in its thread, in order, replacing its pending copy. */
function place(message: ChatMessage, opened: boolean) {
  lastSeen = Math.max(lastSeen, message.id)
  const friendId = otherOf(message)
  patchThread(friendId, (t) => {
    const others = t.messages.filter((m) => m.clientId !== message.clientId && (m.id === 0 || m.id !== message.id))
    const known = t.messages.some((m) => m.id === message.id && m.id !== 0)
    const messages = [...others, message].sort(byOrder)
    const fromThem = message.from === friendId
    return { ...t, messages, unread: fromThem && !known && !opened ? t.unread + 1 : t.unread, typingUntil: fromThem ? 0 : t.typingUntil }
  })
}

function byOrder(a: ChatMessage, b: ChatMessage): number {
  if (a.id && b.id) return a.id - b.id
  if (!a.id && !b.id) return Date.parse(a.at) - Date.parse(b.at)
  return a.id ? -1 : 1
}

// Which thread is on screen now: its messages count as read as they come.
let openThread: number | null = null

async function receive(wire: WireMessage) {
  const message = await decrypt(wire)
  const friendId = otherOf(message)
  const showing = openThread === friendId && document.visibilityState === 'visible'
  place(message, showing)
  if (showing && message.from === friendId) void markRead(friendId)
}

async function catchUp(mine: number) {
  if (!device) return
  if (lastSeen === 0) {
    await loadThreads()
    return
  }
  const response = await fetch(`/api/dm/since?device=${device.deviceId}&after=${lastSeen}`)
  if (!response.ok || state.me !== mine) return
  const { messages } = await response.json() as { messages: WireMessage[] }
  for (const wire of messages) await receive(wire)
}

async function loadThreads() {
  if (!device) return
  const response = await fetch(`/api/dm/threads?device=${device.deviceId}`)
  if (!response.ok) return
  const { threads } = await response.json() as { threads: { other: number; last?: WireMessage; unread: number; theyRead: number }[] }
  const next: Record<number, Thread> = { ...state.threads }
  for (const each of threads) {
    const current = next[each.other] ?? thread(each.other)
    const last = each.last ? await decrypt(each.last) : null
    if (last) lastSeen = Math.max(lastSeen, last.id)
    const messages = last && !current.messages.some((m) => m.id === last.id) ? [...current.messages, last].sort(byOrder) : current.messages
    next[each.other] = { ...current, messages, unread: each.unread, theyRead: each.theyRead }
  }
  publish({ ...state, threads: next })
}

/** The older page of a conversation, or its first one. */
export async function loadThread(friendId: number, older = false): Promise<void> {
  const current = thread(friendId)
  if (!device || current.loading || (older && !current.more)) return
  patchThread(friendId, (t) => ({ ...t, loading: true }))
  try {
    const first = current.messages.find((m) => m.id > 0)
    const before = older && first ? `&before=${first.id}` : ''
    const response = await fetch(`/api/dm/with/${friendId}?device=${device.deviceId}${before}`)
    if (!response.ok) throw new Error(`thread ${response.status}`)
    const page = await response.json() as { messages: WireMessage[]; theyRead: number; more: boolean }
    await keysWith(friendId).catch(() => undefined)
    const opened = await Promise.all(page.messages.map(decrypt))
    for (const m of opened) lastSeen = Math.max(lastSeen, m.id)
    patchThread(friendId, (t) => {
      const ids = new Set(opened.map((m) => m.id))
      const messages = [...t.messages.filter((m) => !ids.has(m.id) || m.id === 0), ...opened].sort(byOrder)
      return { ...t, messages, loaded: true, loading: false, more: older || !t.loaded ? page.more : t.more, theyRead: page.theyRead }
    })
  } catch {
    patchThread(friendId, (t) => ({ ...t, loading: false }))
  }
}

/** Marks the thread read up to its newest message from the friend. */
export async function markRead(friendId: number): Promise<void> {
  const t = thread(friendId)
  const newest = [...t.messages].reverse().find((m) => m.from === friendId && m.id > 0)
  if (t.unread > 0) patchThread(friendId, (current) => ({ ...current, unread: 0 }))
  if (!newest) return
  await fetch(`/api/dm/with/${friendId}/read`, { method: 'POST', headers: json, body: JSON.stringify({ upTo: newest.id }) }).catch(() => undefined)
}

/** Says which thread is on screen; null when none. */
export function showThread(friendId: number | null) {
  openThread = friendId
  if (friendId !== null) void markRead(friendId)
}

function newClientId(): string {
  return toBase64Url(randomBytes(12))
}

/** Seals and sends a message; it shows at once and settles as the server answers. */
export async function sendMessage(friendId: number, text: string, clientId = newClientId()): Promise<void> {
  const me = state.me
  const trimmed = text.trim()
  if (!me || !device || !trimmed) return
  const pending: ChatMessage = { id: 0, clientId, from: me, to: friendId, at: new Date().toISOString(), text: trimmed, state: 'sending' }
  patchThread(friendId, (t) => ({ ...t, messages: [...t.messages.filter((m) => m.clientId !== clientId), pending].sort(byOrder) }))
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const devices = await keysWith(friendId, attempt > 0)
      const recipients = await Promise.all([...devices.mine, ...devices.theirs].map(async (d) => ({ deviceId: d.id, wrapKey: await wrapKeyFor(d.id, d.publicKey) })))
      const sealed = await seal(trimmed, me, friendId, clientId, recipients)
      const response = await fetch(`/api/dm/with/${friendId}`, {
        method: 'POST', headers: json,
        body: JSON.stringify({ senderDevice: device.deviceId, clientId, ...sealed }),
      })
      if (response.status === 409) {
        const body = await response.json().catch(() => null) as { error?: string; mine?: ServerDevice[]; theirs?: ServerDevice[] } | null
        if (body?.error === 'unknown_device') {
          await restart()
          throw new Error('device gone')
        }
        if (body?.mine && body.theirs) {
          remember(body.mine)
          remember(body.theirs)
          pairDevices.set(friendId, { mine: body.mine, theirs: body.theirs })
        }
        continue
      }
      if (!response.ok) throw new Error(`send ${response.status}`)
      const sent = await response.json() as WireMessage
      place({ id: sent.id, clientId, from: me, to: friendId, at: sent.at, text: trimmed, state: 'sent' }, true)
      return
    }
    throw new Error('devices kept changing')
  } catch {
    patchThread(friendId, (t) => ({ ...t, messages: t.messages.map((m) => m.clientId === clientId && m.id === 0 ? { ...m, state: 'failed' } : m) }))
  }
}

/** Tries a failed message again, as the same message. */
export function retryMessage(friendId: number, clientId: string) {
  const failed = thread(friendId).messages.find((m) => m.clientId === clientId)
  if (failed?.text) void sendMessage(friendId, failed.text, clientId)
}

let lastTyping = 0

/** Tells the friend one is typing, at most every few seconds. */
export function typing(friendId: number) {
  const now = Date.now()
  if (now - lastTyping < 3000 || socket?.readyState !== WebSocket.OPEN) return
  lastTyping = now
  socket.send(JSON.stringify({ type: 'typing', to: friendId }))
}

let friendsTimer: ReturnType<typeof setTimeout> | undefined

function friendsChanged() {
  clearTimeout(friendsTimer)
  friendsTimer = setTimeout(() => publish({ ...state, friendsVersion: state.friendsVersion + 1 }), 300)
}

function handle(event: { type: string; id?: number; from?: number; upTo?: number; message?: WireMessage }) {
  switch (event.type) {
    case 'dm':
      if (event.message) void receive(event.message)
      break
    case 'read':
      if (event.from) patchThread(event.from, (t) => ({ ...t, theyRead: Math.max(t.theyRead, event.upTo ?? 0) }))
      break
    case 'readMine':
      if (event.from) patchThread(event.from, (t) => ({ ...t, unread: 0 }))
      break
    case 'typing':
      if (event.from) patchThread(event.from, (t) => ({ ...t, typingUntil: Date.now() + 5000 }))
      break
    case 'presence':
    case 'friends':
      friendsChanged()
      break
    case 'notifications':
      void refreshNotifications()
      break
  }
}

function connect(mine: number, run: number) {
  if (run !== generation || !device) return
  clearTimeout(retryTimer)
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${scheme}://${location.host}/ws/inbox?device=${device.deviceId}`)
  socket = ws
  publish({ ...state, status: 'connecting' })
  let alive: ReturnType<typeof setInterval> | undefined
  ws.onopen = () => {
    if (run !== generation) return
    retry = 0
    publish({ ...state, status: 'live' })
    void catchUp(mine)
    friendsChanged()
    void refreshNotifications()
    alive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}') }, 25_000)
  }
  ws.onmessage = (event) => {
    try { handle(JSON.parse(String(event.data))) } catch { /* not ours */ }
  }
  ws.onclose = () => {
    clearInterval(alive)
    if (socket === ws) socket = null
    if (run !== generation) return
    publish({ ...state, status: 'connecting' })
    // The device may have been pushed out by a newer one: register again.
    const wait = Math.min(30_000, 1000 * 2 ** retry) + Math.random() * 500
    retry++
    retryTimer = setTimeout(() => { void reconnect(mine, run) }, wait)
  }
}

async function reconnect(mine: number, run: number) {
  if (run !== generation) return
  if (retry > 2) {
    try {
      device = await registerDevice(mine)
      wrapKeys.clear()
    } catch { /* offline: try again later */ }
  }
  connect(mine, run)
}

async function start(mine: number) {
  const run = ++generation
  publish({ ...empty, me: mine, status: 'connecting' })
  if (typeof indexedDB === 'undefined' || !crypto?.subtle) {
    publish({ ...state, status: 'unsupported' })
    return
  }
  try {
    device = await registerDevice(mine)
  } catch {
    if (run !== generation) return
    retryTimer = setTimeout(() => { void start(mine) }, 5000)
    return
  }
  if (run !== generation) return
  connect(mine, run)
}

function stop() {
  generation++
  clearTimeout(retryTimer)
  socket?.close()
  socket = null
  device = null
  lastSeen = 0
  publicKeys.clear()
  wrapKeys.clear()
  pairDevices.clear()
  publish(empty)
}

async function restart() {
  const mine = state.me
  if (mine === null) return
  await forgetDevice(mine).catch(() => undefined)
  stop()
  void start(mine)
}

function wake() {
  if (state.me === null || document.visibilityState !== 'visible') return
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    retry = 0
    const mine = state.me
    void reconnect(mine, generation)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', wake)
}

/** Keeps the inbox open for the account signed in, or closes it. */
export function useInboxFor(accountId: number | null) {
  useEffect(() => {
    if (accountId === state.me) return
    if (accountId === null) stop()
    else void start(accountId)
  }, [accountId])
}

export function useInbox(): InboxState {
  return useSyncExternalStore(subscribe, () => state)
}

export function unreadTotal(inbox: InboxState): number {
  return Object.values(inbox.threads).reduce((sum, t) => sum + t.unread, 0)
}

export function resetInboxForTests() {
  stop()
}
