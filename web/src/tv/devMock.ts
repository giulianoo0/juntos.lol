/**
 * Dev only (`/tv?mock`): a pretend server for walking the TV page in a
 * browser. The code links on its third poll; `window.tvMock.cast()` mirrors a
 * room with people, chat and a screen; `window.tvMock.stop()` ends it.
 * `?mock=reset` forgets the token first. Never part of a production build.
 */
import type { RoomInfo } from '../types'

const account = { id: 9, nickname: 'Giuli', avatar: 'fox.bowtie' }
const device = { id: 'd1', name: 'Sala' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const members = [
  { id: 'm1', nickname: 'Giuli', joinedAt: '', accountId: 9, avatar: 'fox.bowtie', tv: true, mic: true },
  { id: 'm2', nickname: 'Ana', joinedAt: '', accountId: 12, avatar: 'cat.beanie', mic: true },
  { id: 'm3', nickname: 'Bruno', joinedAt: '', avatar: 'owl' },
]

function room(id: string): RoomInfo {
  return {
    id, name: 'Sessão de sexta', fileName: '', status: 'empty', mediaGeneration: 0, controllerId: 'm2', audioTracks: null,
    subtitleTracks: null, bitmapSubsSkipped: 0, memberCount: 3, expiresAt: '2099-01-01T00:00:00Z', createdAt: new Date().toISOString(),
    screens: [{ memberId: 'm2', nickname: 'Ana', since: new Date().toISOString() }],
  }
}

type Listener = { onopen: (() => void) | null; onmessage: ((event: { data: string }) => void) | null; onclose: (() => void) | null }

export function installTvMock(): void {
  const params = new URLSearchParams(window.location.search)
  if (params.get('mock') === 'reset') localStorage.removeItem('juntos.tv.token')
  const realFetch = window.fetch.bind(window)
  const RealSocket = window.WebSocket
  let polls = 0
  let tvSocket: Listener | null = null

  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = url.replace(window.location.origin, '')
    if (path === '/api/tv/pair' && init?.method === 'POST') {
      polls = 0
      return json({ pairId: 'p1', code: 'K7Q2M9XA', expiresAt: new Date(Date.now() + 600_000).toISOString() })
    }
    if (path.startsWith('/api/tv/pair/')) {
      polls += 1
      return polls >= 3 ? json({ status: 'linked', token: 'dev-token', account, device }) : json({ status: 'pending' })
    }
    if (path === '/api/tv/me') return json({ account, device })
    const roomPath = /^\/api\/rooms\/([^/?]+)$/.exec(path)
    if (roomPath) return json(room(decodeURIComponent(roomPath[1]!)))
    if (/\/screenshare\/token$|\/call\/token$/.test(path)) return json({ error: 'screenshare_disabled' }, 503)
    return realFetch(input, init)
  }

  class MockSocket {
    static OPEN = 1
    readyState = 0
    onopen: (() => void) | null = null
    onmessage: ((event: { data: string }) => void) | null = null
    onclose: (() => void) | null = null
    url: string
    constructor(url: string) {
      this.url = url
      if (url.includes('/ws/tv')) tvSocket = this
      setTimeout(() => {
        this.readyState = 1
        this.onopen?.()
        if (url.includes('/ws/tv')) this.push({ type: 'mix', mix: { media: 1, people: {} } })
      }, 50)
    }
    push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }) }
    send(data: string) {
      const message = JSON.parse(data) as { type: string; clientTimeMs?: number }
      if (message.type !== 'heartbeat' && message.type !== 'ready') console.info('[tv mock] sent', data)
      if (message.type === 'hello') {
        const at = new Date().toISOString()
        this.push({
          type: 'welcome', memberId: 'tv1', capability: 'cap', controllerId: 'm2', members, gating: false,
          history: [
            { author: 'Ana', text: 'chegou a TV!', at },
            { author: 'Bruno', text: 'bora começar?', at },
          ],
          state: { playing: false, positionMs: 0, rate: 1, serverTimeMs: Date.now() },
        })
      }
      if (message.type === 'heartbeat') this.push({ type: 'pong', serverTimeMs: Date.now(), clientTimeMs: message.clientTimeMs })
    }
    close() { this.readyState = 3 }
  }
  window.WebSocket = new Proxy(RealSocket, {
    construct(target, args: [string, ...unknown[]]) {
      const [url] = args
      return /\/ws\/(tv|rooms)/.test(url) ? new MockSocket(url) : new target(...(args as [string]))
    },
  })

  const send = (message: unknown) => (tvSocket as unknown as MockSocket | null)?.push(message)
  ;(window as unknown as { tvMock: unknown }).tvMock = {
    cast: (roomId = 'R1') => send({ type: 'cast', roomId, ticket: 'dev-ticket' }),
    stop: () => send({ type: 'stop' }),
    revoke: () => send({ type: 'revoked' }),
    mix: (mix: unknown) => send({ type: 'mix', mix }),
  }
}
