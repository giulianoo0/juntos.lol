import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const moduleBase = process.env.WEBTORRENT_MODULE_ROOT
  ? new URL(`file://${process.env.WEBTORRENT_MODULE_ROOT.replace(/\/$/, '')}/package.json`)
  : import.meta.url
const require = createRequire(moduleBase)
const WebTorrent = (await import(require.resolve('webtorrent'))).default

const PORT = Number(process.env.PORT || 8090)
const CACHE_PATH = process.env.TORRENT_CACHE_PATH || '/cache'
const MAX_BODY_BYTES = 8192
const MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024
const MAX_READ_BYTES = 8 * 1024 * 1024
// Side files are fetched whole in one request. Subtitles are far below this;
// the cap keeps the endpoint from being used to pull arbitrary payloads.
const MAX_SIDE_FILE_BYTES = 8 * 1024 * 1024
const MAX_TORRENTS = 4
const IDLE_MS = 10 * 60 * 1000
const TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
]

const client = new WebTorrent({ dht: true })
const torrents = new Map()
const sessions = new Map()

function safeMagnet(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('invalid magnet')
  const input = new URL(value)
  if (input.protocol !== 'magnet:') throw new Error('invalid magnet')
  const xt = input.searchParams.get('xt') || ''
  if (!/^urn:btih:(?:[a-f\d]{40}|[a-z\d]{32})$/i.test(xt)) throw new Error('invalid info hash')
  let output = `magnet:?xt=${xt}`
  const name = input.searchParams.get('dn')
  if (name) output += `&dn=${encodeURIComponent(name.slice(0, 255))}`
  for (const tracker of TRACKERS) output += `&tr=${encodeURIComponent(tracker)}`
  return { magnet: output, hash: xt.slice('urn:btih:'.length).toLowerCase() }
}

function torrentMetadata(entry) {
  return {
    name: entry.torrent.name,
    magnet: entry.magnet,
    files: entry.torrent.files.map((file) => ({ name: file.name, path: file.path, size: file.length, type: file.type })),
    stats: torrentStats(entry.torrent),
  }
}

function torrentStats(torrent) {
  return {
    peers: torrent.numPeers,
    downloadSpeed: torrent.downloadSpeed,
    downloaded: torrent.downloaded,
    progress: torrent.progress,
  }
}

async function openTorrent(rawMagnet) {
  const startedAt = Date.now()
  const { magnet, hash } = safeMagnet(rawMagnet)
  let entry = torrents.get(hash)
  if (!entry) {
    if (torrents.size >= MAX_TORRENTS) throw new Error('bridge busy')
    entry = { magnet, torrent: null, ready: null, refs: 0, lastUsed: Date.now() }
    entry.ready = new Promise((resolve, reject) => {
      let torrent
      const timeout = setTimeout(() => {
        reject(new Error('torrent metadata timeout'))
        if (torrent) void client.remove(torrent, { destroyStore: true }).catch(() => undefined)
      }, 30_000)
      torrent = client.add(magnet, { deselect: true, path: CACHE_PATH }, (ready) => {
        clearTimeout(timeout)
        entry.torrent = ready
        resolve(entry)
      })
      torrent.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
    torrents.set(hash, entry)
    entry.ready.catch(() => torrents.delete(hash))
  }
  entry = await entry.ready
  entry.refs += 1
  entry.lastUsed = Date.now()
  const id = randomUUID()
  sessions.set(id, { hash, entry, selected: '', lastUsed: Date.now() })
  console.log(JSON.stringify({ event: 'torrent_open', hash, files: entry.torrent.files.length, peers: entry.torrent.numPeers, elapsedMs: Date.now() - startedAt }))
  return { id, ...torrentMetadata(entry) }
}

function selectFile(id, path) {
  const session = sessions.get(id)
  if (!session) throw new Error('session not found')
  const file = session.entry.torrent.files.find((candidate) => candidate.path === path)
  if (!file || file.length <= 0 || file.length > MAX_FILE_BYTES) throw new Error('invalid file')
  for (const candidate of session.entry.torrent.files) candidate.deselect()
  // Select the whole file at low priority. Reads still raise a critical,
  // tightly scoped window for the bytes needed next, so the first playable
  // chunk is never starved; the standing selection is only what keeps peers
  // busy in between, which is otherwise dead time.
  file.select(0)
  session.selected = path
  session.lastUsed = Date.now()
  session.entry.lastUsed = Date.now()
  console.log(JSON.stringify({ event: 'torrent_select', hash: session.hash, bytes: file.length, peers: session.entry.torrent.numPeers }))
  return { ok: true }
}

function getSession(id) {
  const session = sessions.get(id)
  if (!session) throw new Error('session not found')
  session.lastUsed = Date.now()
  session.entry.lastUsed = Date.now()
  return session
}

function getStats(id) {
  return torrentStats(getSession(id).entry.torrent)
}

// The file list of an already-open session. The server-side ingest needs it to
// find the sibling subtitle files without holding the browser's reply.
function getFiles(id) {
  const session = getSession(id)
  return torrentMetadata(session.entry)
}

async function readRange(session, file, start, end, event) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.length) {
    throw new Error('invalid byte range')
  }
  const length = end - start + 1
  if (length > MAX_READ_BYTES) throw new Error('byte range too large')

  const startedAt = Date.now()
  const data = await file.arrayBuffer({ start, end })
  session.lastUsed = Date.now()
  session.entry.lastUsed = Date.now()
  console.log(JSON.stringify({
    event,
    hash: session.hash,
    start,
    bytes: data.byteLength,
    peers: session.entry.torrent.numPeers,
    elapsedMs: Date.now() - startedAt,
  }))
  return data
}

// Streams the selected file from `start` to its end over a single response.
//
// This is what the server-side ingest uses, and it is the only shape that lets
// the swarm work ahead: one iterator selects every remaining piece at once and
// keeps `critical` on the few just past the read pointer. Byte-range reads can
// only ever select the range they were asked for, so between two of them the
// swarm has nothing selected and stops downloading entirely.
function streamSelectedFile(id, start) {
  const session = getSession(id)
  if (!session.selected) throw new Error('file not selected')
  const file = session.entry.torrent.files.find((candidate) => candidate.path === session.selected)
  if (!file) throw new Error('selected file not found')
  if (!Number.isSafeInteger(start) || start < 0 || start >= file.length) throw new Error('invalid byte range')
  return { session, file, stream: file.createReadStream({ start }) }
}

async function readSelectedFile(id, start, end) {
  const session = getSession(id)
  if (!session.selected) throw new Error('file not selected')
  const file = session.entry.torrent.files.find((candidate) => candidate.path === session.selected)
  if (!file) throw new Error('selected file not found')
  return readRange(session, file, start, end, 'torrent_read')
}

// Reads any file of the same torrent without changing the session selection.
// External subtitles ship as small sibling files, so they can be fetched
// alongside the video stream without competing for its piece priority.
async function readSideFile(id, path, start, end) {
  const session = getSession(id)
  const file = session.entry.torrent.files.find((candidate) => candidate.path === path)
  if (!file || file.length <= 0) throw new Error('invalid file')
  if (file.length > MAX_SIDE_FILE_BYTES) throw new Error('file too large')
  return readRange(session, file, start, end, 'torrent_read_side')
}

async function closeSession(id) {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  session.entry.refs -= 1
  if (session.entry.refs > 0) return
  torrents.delete(session.hash)
  try { await client.remove(session.entry.torrent, { destroyStore: true }) } catch { /* already closed */ }
}

async function readJSON(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, body) {
  const data = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(data)
}

// Pipes a torrent read stream into the response. Length is unknown up front
// (the stream ends with the file), so the response is chunked and a failure
// mid-body can only be signalled by destroying the socket: the ingest treats a
// short body as resumable and continues from the offset it actually stored.
function streamBinary(response, request, { session, file, stream }, start) {
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Stream-Length': String(file.length - start),
  })
  const startedAt = Date.now()
  let sent = 0
  // A stream can run for hours, and the idle sweeper only looks at lastUsed.
  const keepAlive = setInterval(() => {
    session.lastUsed = Date.now()
    session.entry.lastUsed = Date.now()
  }, 30_000)
  const finish = (event) => {
    clearInterval(keepAlive)
    session.lastUsed = Date.now()
    session.entry.lastUsed = Date.now()
    console.log(JSON.stringify({
      event,
      hash: session.hash,
      start,
      bytes: sent,
      peers: session.entry.torrent.numPeers,
      elapsedMs: Date.now() - startedAt,
    }))
  }
  stream.on('data', (chunk) => { sent += chunk.length })
  stream.on('error', () => { finish('torrent_stream_error'); response.destroy() })
  stream.on('end', () => finish('torrent_stream_end'))
  // The consumer going away has to tear the iterator down, or its selection
  // keeps the swarm downloading a file nobody is reading any more.
  request.on('close', () => { if (!stream.destroyed) stream.destroy() })
  stream.pipe(response)
}

function binary(response, data) {
  const body = Buffer.from(data)
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(body)
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/healthz') return json(response, 200, { ok: true })
    if (request.method !== 'POST') return json(response, 404, { error: 'not found' })
    const body = await readJSON(request)
    if (request.url === '/api/torrent-bridge/open') return json(response, 200, await openTorrent(body.magnet))
    if (request.url === '/api/torrent-bridge/select') return json(response, 200, selectFile(body.id, body.path))
    if (request.url === '/api/torrent-bridge/stats') return json(response, 200, getStats(body.id))
    if (request.url === '/api/torrent-bridge/files') return json(response, 200, getFiles(body.id))
    if (request.url === '/api/torrent-bridge/stream') {
      return streamBinary(response, request, streamSelectedFile(body.id, body.start), body.start)
    }
    if (request.url === '/api/torrent-bridge/read') return binary(response, await readSelectedFile(body.id, body.start, body.end))
    if (request.url === '/api/torrent-bridge/read-file') return binary(response, await readSideFile(body.id, body.path, body.start, body.end))
    if (request.url === '/api/torrent-bridge/close') {
      await closeSession(body.id)
      return json(response, 200, { ok: true })
    }
    return json(response, 404, { error: 'not found' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'bridge error'
    json(response, message === 'bridge busy' ? 503 : 400, { error: message })
  }
})

setInterval(() => {
  const cutoff = Date.now() - IDLE_MS
  for (const [id, session] of sessions) {
    if (session.lastUsed < cutoff) void closeSession(id)
  }
}, 60_000).unref()

client.on('error', (error) => console.error('webtorrent client error', error))
server.listen(PORT, '0.0.0.0', () => console.log(`torrent bridge listening on :${PORT}`))

function shutdown() {
  server.close(() => client.destroy(() => process.exit(0)))
  setTimeout(() => process.exit(1), 5000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
