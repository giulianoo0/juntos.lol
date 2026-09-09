import { useEffect, useState } from 'react'

/** The companion's fixed loopback port; the web never port-hops. */
export const JLOCAL_URL = 'http://127.0.0.1:40392'
export const JLOCAL_RELEASES_URL = 'https://github.com/giulianoo0/jlocal/releases/latest'

const PROBE_TIMEOUT_MS = 1_500
const POLL_ABSENT_MS = 5_000
const POLL_PRESENT_MS = 10_000

export interface JlocalStatus {
  connected: boolean
  version: string | null
}

const OFFLINE: JlocalStatus = { connected: false, version: null }

async function probe(): Promise<JlocalStatus> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(`${JLOCAL_URL}/health`, { signal: controller.signal, cache: 'no-store' })
    if (!response.ok) return OFFLINE
    const body = await response.json() as { name?: string; version?: string; connected?: boolean }
    if (body.name !== 'jlocal') return OFFLINE
    return { connected: body.connected !== false, version: body.version ?? null }
  } catch {
    return OFFLINE
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether the jlocal companion is running on this machine. Polls the
 * loopback health endpoint: quickly while absent, so installing it is
 * noticed within seconds, and lazily once it is there.
 */
export function useJlocal(): JlocalStatus {
  const [status, setStatus] = useState<JlocalStatus>(OFFLINE)

  useEffect(() => {
    if (typeof fetch !== 'function') return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      const next = await probe()
      if (disposed) return
      setStatus((current) => (current.connected === next.connected && current.version === next.version ? current : next))
      timer = setTimeout(tick, next.connected ? POLL_PRESENT_MS : POLL_ABSENT_MS)
    }
    void tick()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [])

  return status
}
