import { useEffect, useState } from 'react'
import { fleetStatus, probeWorkers, type Fleet, type FleetMember, type WorkerProbe } from '../remoteTorrent'
import { useT } from '../i18n/useT'

// The fleet moves on ten-second heartbeats, so anything faster would redraw
// the same numbers; anything much slower and the page is describing a fleet
// that has moved on.
const REFRESH_MS = 10_000

function gib(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`
}

// The worker's "bps" fields are bytes per second — capBps is the configured
// ceiling in bytes, usedBps a delta of bytes_served — so a megabit is 125_000
// of them, not a million. Dividing by 1e6 printed a 600 Mbit/s pipe as 75.
function mbit(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 125_000).toFixed(1)} Mbit/s`
}

function uptime(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

/**
 * The fleet, best for this viewer first.
 *
 * The order is the server's, and deliberately so: it is the same ranking
 * placement uses to choose, so the worker at the top is genuinely where the
 * next room would land. A page that sorted by its own idea of "best" would
 * be describing a system that does not exist.
 */
export function FleetStatus() {
  const t = useT()
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [failed, setFailed] = useState(false)
  const [probes, setProbes] = useState<WorkerProbe[]>([])
  // Measuring can also simply fail — no session, no workers listed — and a
  // card that says "measuring…" forever is worse than one that admits it
  // never found out.
  const [probing, setProbing] = useState(true)

  useEffect(() => {
    let disposed = false
    const read = async () => {
      try {
        const next = await fleetStatus()
        if (disposed) return
        setFleet(next)
        setFailed(false)
      } catch {
        // The last good picture stays on screen: a blip in the poll is not
        // news about the fleet, and blanking the page would say it was.
        if (!disposed) setFailed(true)
      }
    }
    void read()
    const timer = window.setInterval(read, REFRESH_MS)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

  // Measured once, not on the poll: this downloads a few megabytes from every
  // worker, and a page that did that every ten seconds would be the heaviest
  // user of the fleet it is reporting on. Speed is not what changes minute to
  // minute anyway — load is, and load comes from the poll.
  useEffect(() => {
    let disposed = false
    void probeWorkers('', (next) => { if (!disposed) setProbes(next) })
      .then((final) => { if (disposed) return; setProbes(final); setProbing(false) })
      .catch(() => { if (!disposed) setProbing(false) })
    return () => { disposed = true }
  }, [])

  if (fleet === null) {
    return (
      <div className="fleet-status" role="status" aria-live="polite">
        {failed ? (
          <p className="fleet-empty">{t('fleet.unreachable')}</p>
        ) : (
          <>
            <span className="sr-only">{t('fleet.loading')}</span>
            <FleetSkeleton />
          </>
        )}
      </div>
    )
  }

  const available = fleet.workers.filter((w) => w.availability === 'available').length
  const speeds = new Map(probes.map((probe) => [probe.id, probe]))
  // Held back until every worker has answered: reordering on each result
  // makes the cards hop under the reader's eyes, and a "best" declared from
  // half the measurements is a guess wearing a badge.
  const measured = !probing && probes.some((probe) => probe.state === 'ok')
  const workers = measured ? rankBySpeed(fleet.workers, speeds) : fleet.workers

  return (
    <div className="fleet-status">
      <header className="fleet-summary">
        <h2>{t('fleet.title')}</h2>
        <p>
          {fleet.capacity === 'disabled'
            ? t('fleet.disabled')
            : fleet.workers.length === 0
              ? t('fleet.none')
              : t('fleet.summary').replace('{available}', String(available)).replace('{total}', String(fleet.workers.length))}
        </p>
        {failed ? <p className="fleet-stale">{t('fleet.stale')}</p> : null}
      </header>

      {workers.length > 0 ? (
        <ol className="fleet-list">
          {workers.map((member, index) => (
            <li key={member.id} className={`fleet-card is-${member.availability}`}>
              <div className="fleet-card-head">
                <code>{member.id.replace(/^w_/, '').slice(0, 8)}</code>
                <span className={`fleet-badge is-${member.availability}`}>{t(`fleet.state.${member.availability}`)}</span>
                {/* Only worth pointing out where it changes a decision: the
                    head of a list of one is not news. */}
                {/* Only once it has been measured, and only where it changes
                    a decision: the head of a list of one is not news. */}
                {measured && index === 0 && member.availability === 'available' && workers.length > 1
                  ? <span className="fleet-best">{t('fleet.best')}</span>
                  : null}
              </div>
              <Meter label={t('fleet.busy')} value={busyness(member)} detail={busyDetail(member, t)} />
              <dl className="fleet-facts">
                {/* Always the same cells in the same places, even when a
                    worker has nothing to report for one: a field that
                    disappears makes two cards impossible to read against each
                    other, and its absence looks like a fault rather than an
                    unset ceiling. */}
                <Fact
                  label={t('fleet.speed')}
                  value={speedLabel(speeds.get(member.id), probing, t)}
                  pending={isMeasuring(speeds.get(member.id), probing)}
                />
                <Fact label={t('fleet.disk')} value={member.diskQuota ? `${gib(member.diskUsed)} / ${gib(member.diskQuota)}` : gib(member.diskUsed)} />
                <Fact
                  label={t('fleet.transfer')}
                  value={member.transferCapBps
                    ? `${mbit(member.transferUsedBps)} / ${mbit(member.transferCapBps)}`
                    : mbit(member.transferUsedBps)}
                  note={member.transferCapBps ? undefined : t('fleet.noCap')}
                />
                <Fact label={t('fleet.torrents')} value={member.maxTorrents ? `${member.torrents} / ${member.maxTorrents}` : String(member.torrents)} />
                <Fact label={t('fleet.uptime')} value={member.uptimeSecs ? uptime(member.uptimeSecs) : '—'} />
                <Fact label={t('fleet.version')} value={member.version || '—'} />
              </dl>
              {member.availability === 'offline' || member.availability === 'draining' ? (
                <p className="fleet-note">
                  {t('fleet.lastSeen').replace('{secs}', String(Math.max(0, member.lastSeenSecs)))}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}

// Fastest from THIS browser first, because that is what the system itself
// goes by: a dispatch carries the page's own measured ranking, and the server
// takes the first of them that has room. A worker in another continent can be
// the least loaded in the fleet and still the worst place for this viewer.
//
// Availability comes first all the same: speed on a worker that cannot take
// the job is a number with nothing behind it.
function rankBySpeed(workers: FleetMember[], speeds: Map<string, WorkerProbe>): FleetMember[] {
  const mbit = (member: FleetMember) => {
    const probe = speeds.get(member.id)
    return probe?.state === 'ok' ? probe.mbit ?? 0 : -1
  }
  return [...workers].sort((a, b) => {
    const canWork = (member: FleetMember) => (member.availability === 'available' ? 0 : 1)
    if (canWork(a) !== canWork(b)) return canWork(a) - canWork(b)
    return mbit(b) - mbit(a)
  })
}

// One cell of the footer grid. The value carries its own shimmer while it is
// still being worked out, so the card reads as "this number is coming" rather
// than as a card with a word where a number belongs.
function Fact({ label, value, note, pending }: { label: string; value: string; note?: string; pending?: boolean }) {
  return (
    <div className="fleet-fact">
      <dt>{label}</dt>
      <dd className={pending ? 'is-pending' : ''}>
        {value}
        {note ? <em>{note}</em> : null}
      </dd>
    </div>
  )
}

function isMeasuring(probe: WorkerProbe | undefined, probing: boolean): boolean {
  return probe ? probe.state === 'testing' : probing
}

function speedLabel(probe: WorkerProbe | undefined, probing: boolean, t: (key: string) => string): string {
  if (!probe) return probing ? t('fleet.measuring') : '—'
  if (probe.state === 'testing') return t('fleet.measuring')
  if (probe.state === 'down') return t('fleet.noPath')
  return `${probe.mbit ?? 0} Mbit/s`
}

// The shape of the answer, drawn before the answer arrives: same header, same
// bar, same row of facts, so nothing jumps when the numbers land. Two cards,
// because promising a number of workers the fleet may not have would be the
// skeleton telling a small lie.
function FleetSkeleton() {
  return (
    <>
      <header className="fleet-summary">
        <span className="fleet-bone is-title" />
        <span className="fleet-bone is-line" />
      </header>
      <ol className="fleet-list" aria-hidden="true">
        {[0, 1].map((index) => (
          <li key={index} className="fleet-card is-skeleton">
            <div className="fleet-card-head">
              <span className="fleet-bone is-id" />
              <span className="fleet-bone is-badge" />
            </div>
            <div className="fleet-meter">
              <div className="fleet-meter-row">
                <span className="fleet-bone is-label" />
                <span className="fleet-bone is-label" />
              </div>
              <div className="fleet-meter-track" />
            </div>
            <div className="fleet-facts">
              {[0, 1, 2].map((fact) => (
                <span key={fact} className="fleet-bone is-fact" />
              ))}
            </div>
          </li>
        ))}
      </ol>
    </>
  )
}

// What a person means by "how busy is it": whichever budget is closest to
// running out, because that is the one that will refuse the next room. The
// composite load the server sorts by would read as half-empty while the pipe
// was already spoken for.
function busyness(member: FleetMember): number {
  const parts = [
    member.maxLeases ? member.leases / member.maxLeases : 0,
    member.maxTorrents ? member.torrents / member.maxTorrents : 0,
    member.diskQuota ? member.diskUsed / member.diskQuota : 0,
    member.transferCapBps ? member.transferUsedBps / member.transferCapBps : 0,
  ]
  return Math.min(1, Math.max(0, ...parts))
}

function busyDetail(member: FleetMember, t: (key: string) => string): string {
  if (member.availability === 'offline') return t('fleet.state.offline')
  if (!member.maxLeases) return `${member.leases}`
  return `${member.leases} / ${member.maxLeases}`
}

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  const pct = Math.round(value * 100)
  return (
    <div className="fleet-meter">
      <div className="fleet-meter-row">
        <span>{label}</span>
        <span>{detail} · {pct}%</span>
      </div>
      <div
        className="fleet-meter-track"
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <span className="fleet-meter-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
