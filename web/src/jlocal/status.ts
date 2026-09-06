import { useSyncExternalStore } from 'react'
import { playJLocalChime } from '../ui/chime'

// The companion app's fixed loopback origin. One port, never scanned:
// the web UI probes exactly this, and the app refuses to hop.
export const JLOCAL_ORIGIN = 'http://127.0.0.1:4173'
const PROBE_TIMEOUT_MS = 1500
const POLL_MS = 10000

export interface JLocalSnapshot {
  connected: boolean
  version: string | null
  connecting: boolean
  modalOpen: boolean
}

const initial: JLocalSnapshot = { connected: false, version: null, connecting: false, modalOpen: false }
let snapshot: JLocalSnapshot = initial
const listeners = new Set<() => void>()
let pollTimer: ReturnType<typeof setInterval> | null = null
let probeEpoch = 0

function emit(next: JLocalSnapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

async function probeVersion(signal: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(`${JLOCAL_ORIGIN}/health`, { signal })
    if (!response.ok) return null
    const body = (await response.json()) as { name?: unknown; version?: unknown }
    return body?.name === 'jlocal' && typeof body.version === 'string' ? body.version : null
  } catch {
    return null
  }
}

async function refresh(manual: boolean): Promise<void> {
  const epoch = ++probeEpoch
  if (manual) emit({ ...snapshot, connecting: true })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  let version: string | null = null
  try {
    version = await probeVersion(controller.signal)
  } finally {
    clearTimeout(timer)
  }
  if (epoch !== probeEpoch) return
  const was = snapshot.connected
  const connected = version !== null
  emit({ ...snapshot, connected, version, connecting: false })
  if (connected && !was) playJLocalChime()
}

function ensurePolling(): void {
  if (pollTimer !== null) return
  pollTimer = setInterval(() => { void refresh(false) }, POLL_MS)
  const unref = (pollTimer as unknown as { unref?: () => void }).unref
  if (typeof unref === 'function') unref.call(pollTimer)
}

export function subscribeJLocal(listener: () => void): () => void {
  listeners.add(listener)
  ensurePolling()
  void refresh(false)
  return () => { listeners.delete(listener) }
}

export function getJLocalSnapshot(): JLocalSnapshot {
  return snapshot
}

/** Manual attempt from the "Connect to J Local" button. Never throws. */
export function connectJLocal(): void {
  void refresh(true)
}

export function setJLocalModal(open: boolean): void {
  if (snapshot.modalOpen !== open) emit({ ...snapshot, modalOpen: open })
}

/** Test-only reset for the module singleton. */
export function resetJLocalForTests(): void {
  probeEpoch += 1
  snapshot = initial
}

export function useJLocal(): JLocalSnapshot & { connect: () => void; setModal: (open: boolean) => void } {
  const snap = useSyncExternalStore(subscribeJLocal, getJLocalSnapshot, getJLocalSnapshot)
  return { ...snap, connect: connectJLocal, setModal: setJLocalModal }
}
