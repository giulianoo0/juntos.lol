import { useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import type { RoomPreparation } from '../types'
import type { RoomUploadProgress } from '../upload'
import type { TorrentStats } from '../torrent'
import { TorrentReadout } from './TorrentReadout'
import { SlotText } from '../ui/SlotText'
import NumberFlow from '@number-flow/react'
import { GATE_OPEN_SEC } from '../player/gate'

/** What the player under the card is waiting on, once the room has media. */
export interface OpeningWait {
  /** Seconds of buffer still to build; null while there is no media at the
   * room's position yet (a cold start). */
  secondsLeft: number | null
  cold: boolean
}

// How long a byte count stays in the rate window. Long enough that a swarm
// pausing on one slow piece does not read as "stalled", short enough that the
// estimate follows a transfer that genuinely speeds up or slows down.
const RATE_WINDOW_MS = 20_000

// A rate below this is treated as no rate at all: dividing by it produces
// estimates in the hours that say nothing anyone can act on.
const MIN_USEFUL_BYTES_PER_SECOND = 16 * 1024

// Rounds a countdown to something a person would say out loud. A number that
// looks measured to the second invites watching it, and it is not that precise.
function formatDuration(seconds: number, t: Translator): string {
  if (seconds < 60) return t('prep.etaUnderAMinute')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('prep.etaMinutes').replace('{n}', String(minutes))
  const hours = Math.round(seconds / 3600)
  return t('prep.etaHours').replace('{n}', String(hours))
}

// Measures how fast bytes are actually arriving, from the counts the server
// publishes. A transfer's own history is the only honest basis for a
// prediction: nothing about the file says how fast the swarm will feed it.
function useTransferRate(receivedBytes: number): number {
  const samples = useRef<{ at: number; bytes: number }[]>([])
  const [rate, setRate] = useState(0)

  useEffect(() => {
    const now = Date.now()
    const history = samples.current
    // A count that went backwards means a new source; the old history
    // describes a different transfer and would poison the estimate.
    if (history.length > 0 && receivedBytes < history[history.length - 1].bytes) history.length = 0
    history.push({ at: now, bytes: receivedBytes })
    while (history.length > 2 && now - history[0].at > RATE_WINDOW_MS) history.shift()

    const oldest = history[0]
    const elapsed = (now - oldest.at) / 1000
    setRate(elapsed >= 1 ? (receivedBytes - oldest.bytes) / elapsed : 0)
  }, [receivedBytes])

  return rate
}

// What the room is waiting for, and how far along it is. The target is the
// point at which playback can begin, which is not the end of the transfer:
// a preview starts from a fraction of the file, and only a source that cannot
// be previewed at all has to wait for the last byte.
function waitTarget(preparation: RoomPreparation): { bytes: number; certain: boolean } {
  if (preparation.previewPhase === 'unavailable') {
    return { bytes: preparation.sourceBytes ?? 0, certain: true }
  }
  return { bytes: preparation.previewTargetBytes ?? 0, certain: false }
}

function phaseKey(preparation: RoomPreparation): string {
  switch (preparation.previewPhase) {
    case 'unavailable': return 'prep.phaseUnavailable'
    case 'segmenting': return 'prep.phaseSegmenting'
    case 'probing': return 'prep.phaseProbing'
    default: return 'prep.phaseReceiving'
  }
}

export function UploadAvailability({
  progress,
  preparation,
  swarm,
  wait,
  t,
}: {
  progress: RoomUploadProgress | null
  preparation?: RoomPreparation | null
  /** Live torrent numbers, present only on the machine fetching the swarm. */
  swarm?: TorrentStats | null
  /** The last stage: the room has media and the player behind this card is
   * building its opening buffer. The card stays until that is done. */
  wait?: OpeningWait | null
  t: Translator
}) {
  // The server's count covers every viewer; the local one only exists in the
  // tab doing the sending, and is the fallback for a transfer this server is
  // not performing itself.
  const received = preparation?.receivedBytes ?? progress?.bytesUploaded ?? 0
  const total = preparation?.sourceBytes ?? progress?.bytesTotal ?? 0
  const rate = useTransferRate(received)

  const prep: RoomPreparation = preparation ?? {}
  const target = waitTarget(prep)

  // The bar tracks the wait that is actually happening: progress towards
  // playable when that point is known, and progress through the file when it
  // is not. Deliberately never the whole file's size — a 7 GB total on screen
  // reads as "you must download 7 GB", when playback starts from a sliver.
  const barTotal = target.bytes > 0 ? target.bytes : total
  const barPct = barTotal > 0 ? Math.min(100, Math.round((received / barTotal) * 100)) : 0

  const remaining = Math.max(0, barTotal - received)
  const eta = rate >= MIN_USEFUL_BYTES_PER_SECOND && remaining > 0 ? remaining / rate : null

  const started = received > 0 || total > 0
  const label = !started
    ? t('room.waitingInitial')
    : barPct >= 100 && prep.previewPhase !== 'unavailable'
      ? t('prep.phaseSegmenting')
      : t(phaseKey(prep))
  const etaLabel = eta !== null ? formatDuration(eta, t) : barPct >= 100 ? t('prep.etaAlmost') : t('prep.etaUnknown')

  // The buffer stage takes over the whole card: the bar becomes the buffer
  // filling towards the gate, the countdown the seconds it still needs.
  const buffering = wait !== null && wait !== undefined
  const bufferLeft = buffering && !wait.cold ? wait.secondsLeft : null
  const bufferPct = bufferLeft === null ? 0 : Math.max(0, Math.min(100, Math.round((1 - bufferLeft / GATE_OPEN_SEC) * 100)))
  const stageKey = !buffering ? label : wait.cold ? 'cold' : 'buffer'
  const shownPct = buffering ? bufferPct : barPct

  return (
    <div className="availability-card">
      <h1>{t('room.processing')}</h1>
      {/* The stages travel through the same line (see SlotText): receiving,
          then analysing, then the first segment, then the buffer being
          built — each one legible as the previous one finishing. */}
      <p>
        <SlotText k={stageKey} block>
          {!buffering ? label : wait.cold ? t('room.preparingPart') : (
            <>
              <span className="text-shimmer">{t('room.bufferingLead')}</span>
              {bufferLeft !== null ? <NumberFlow value={bufferLeft} suffix={t('room.bufferingTail')} /> : null}
            </>
          )}
        </SlotText>
      </p>
      <div className="availability-meter">
        {/* No size, no percentage: a calm shimmer that stays alive even at zero,
            so a slow start never reads as stuck. */}
        <div
          className={`prep-bar ${shownPct > 0 ? 'is-progress' : 'is-indeterminate'}`}
          role="progressbar"
          aria-label={t('prep.untilPlayable')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={shownPct}
        >
          <span style={shownPct > 0 ? { width: `${shownPct}%` } : undefined} />
        </div>
        <div className="prep-eta">
          <span>{buffering || (target.bytes > 0 && !target.certain) ? t('prep.untilPlayable') : t('prep.untilComplete')}</span>
          {buffering
            ? <strong>{bufferLeft !== null ? <NumberFlow value={bufferLeft} suffix={t('room.bufferingTail')} /> : t('prep.etaUnknown')}</strong>
            : <strong>{etaLabel}</strong>}
        </div>
      </div>
      {swarm ? <TorrentReadout stats={swarm} /> : null}
    </div>
  )
}
