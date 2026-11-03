import { incidentalAudio } from './audioUnlock'
/**
 * The room's small sounds: you walking in, someone arriving or leaving, a
 * message, a knock at the door. They are Visual Studio Code's accessibility
 * signals (MIT, public/sounds/LICENSE.txt), made to be told apart by ear.
 */

type Cue = 'entered' | 'join' | 'leave' | 'message' | 'knock' | 'request' | 'jlocal'

const CUES: Record<Cue, { file: string; volume: number }> = {
  entered: { file: 'editsKept', volume: 0.4 },
  join: { file: 'voiceRecordingStarted', volume: 0.35 },
  leave: { file: 'voiceRecordingStopped', volume: 0.35 },
  message: { file: 'chatEditModifiedFile', volume: 0.3 },
  knock: { file: 'chatUserActionRequired', volume: 0.45 },
  request: { file: 'terminalBell', volume: 0.35 },
  jlocal: { file: 'success', volume: 0.35 },
}

let context: AudioContext | null = null
const buffers = new Map<Cue, Promise<AudioBuffer | null>>()

function audio(): AudioContext | null {
  if (typeof AudioContext === 'undefined') return null
  context ??= incidentalAudio(new AudioContext())
  return context
}

function bufferOf(ctx: AudioContext, cue: Cue): Promise<AudioBuffer | null> {
  let buffer = buffers.get(cue)
  if (!buffer) {
    buffer = fetch(`/sounds/${CUES[cue].file}.mp3`)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error('missing'))))
      .then((bytes) => ctx.decodeAudioData(bytes))
      .catch(() => {
        // A failed fetch may try again next time.
        buffers.delete(cue)
        return null
      })
    buffers.set(cue, buffer)
  }
  return buffer
}

// The same sound twice inside this window is one sound: three people
// arriving together are one arrival, not a chord.
const REPEAT_MS = 350
const lastPlayed = new Map<Cue, number>()
const WAKE_MS = 500

/** Plays nothing before a gesture has unlocked audio, and nothing for a reader who asked for calm. */
function play(cue: Cue): void {
  const ctx = audio()
  if (!ctx) return
  // Fetched on the first ask even when it cannot sound yet, so the next one is ready.
  const buffer = bufferOf(ctx, cue)
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  if (ctx.state !== 'running') {
    // Right after a tap the context is still waking; later than this, the
    // sound would arrive for nothing that is happening now.
    const asked = performance.now()
    void ctx.resume().then(() => { if (performance.now() - asked < WAKE_MS) sound(ctx, cue, buffer) }, () => undefined)
    return
  }
  sound(ctx, cue, buffer)
}

function sound(ctx: AudioContext, cue: Cue, buffer: Promise<AudioBuffer | null>): void {
  const now = performance.now()
  if (now - (lastPlayed.get(cue) ?? -Infinity) < REPEAT_MS) return
  lastPlayed.set(cue, now)
  void buffer.then((decoded) => {
    if (!decoded) return
    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    source.buffer = decoded
    gain.gain.value = CUES[cue].volume
    source.connect(gain).connect(ctx.destination)
    source.start()
  })
}

/** Fetches every sound ahead, so the first of each is on time. */
export function preloadChimes(): void {
  const ctx = audio()
  if (!ctx) return
  for (const cue of Object.keys(CUES) as Cue[]) void bufferOf(ctx, cue)
}

/** You are in the room. */
export const playEnteredChime = () => play('entered')
/** Someone came in. */
export const playJoinChime = () => play('join')
/** Someone left. */
export const playLeaveChime = () => play('leave')
/** A message from someone else. */
export const playMessageChime = () => play('message')
/** Someone at the door, for the host to let in. */
export const playKnockChime = () => play('knock')
/** Someone asks the host for the stage. */
export const playRequestChime = () => play('request')
/** The jlocal companion connected. */
export const playJLocalChime = () => play('jlocal')
