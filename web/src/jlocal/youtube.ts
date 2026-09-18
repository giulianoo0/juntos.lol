/**
 * The companion app as a YouTube backend: yt-dlp and FFmpeg on the host's
 * own machine resolve the link and produce the room (see ./production).
 */
import { JLOCAL_ORIGIN, getJLocalSnapshot } from './status'
import { startJlocalProduction, withTimeout } from './production'
import { YoutubeError, type YoutubeBackend, type YoutubeCapacity, type YoutubeSummary } from '../youtube'

const PROBE_TIMEOUT_MS = 2500
const RESOLVE_TIMEOUT_MS = 150_000

export type JlocalToolsStatus =
  | { status: 'unsupported' }
  | { status: 'missing' }
  | { status: 'downloading'; done: number; total: number }
  | { status: 'ready' }
  | { status: 'failed'; error: string }

/** The tools' state as the app reports it; null when the app is not there. */
export async function jlocalToolsStatus(): Promise<JlocalToolsStatus | null> {
  if (!getJLocalSnapshot().connected) return null
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/youtube/tools`, { signal: withTimeout(PROBE_TIMEOUT_MS) })
    if (!response.ok) return null
    return await response.json() as JlocalToolsStatus
  } catch {
    return null
  }
}

/** Asks the app to fetch yt-dlp and FFmpeg; the status then moves through downloading. */
export async function installJlocalTools(): Promise<JlocalToolsStatus | null> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/youtube/tools`, { method: 'POST', signal: withTimeout(PROBE_TIMEOUT_MS) })
    return await response.json() as JlocalToolsStatus
  } catch {
    return null
  }
}

export const jlocalBackend: YoutubeBackend = {
  name: 'jlocal',
  async capacity(): Promise<YoutubeCapacity> {
    const tools = await jlocalToolsStatus()
    return tools?.status === 'ready' ? 'available' : 'disabled'
  },
  async resolve(url) {
    let response: Response
    try {
      response = await fetch(`${JLOCAL_ORIGIN}/youtube/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: withTimeout(RESOLVE_TIMEOUT_MS),
      })
    } catch (error) {
      throw new YoutubeError('failed', `jlocal resolve failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = await response.json().catch(() => ({})) as { summary?: YoutubeSummary; error?: string; detail?: string }
    if (!response.ok || !body.summary) {
      const code = body.error ?? ''
      if (code === 'tools_missing' || code === 'unsupported') throw new YoutubeError('no_workers')
      if (code === 'invalid_url') throw new YoutubeError('invalid')
      if (code.startsWith('youtube_')) throw new YoutubeError(code, body.detail)
      throw new YoutubeError('failed', body.detail ?? code ?? `status ${response.status}`)
    }
    return { url, videoId: body.summary.videoId, summary: body.summary, backend: 'jlocal', destroy: () => undefined }
  },
  async start(session, { roomId, mediaGeneration }) {
    return await startJlocalProduction('youtube', { url: session.url }, roomId, mediaGeneration)
  },
}
