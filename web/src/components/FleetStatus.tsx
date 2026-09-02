import { useEffect, useState } from 'react'
import NumberFlow from '@number-flow/react'
import { fleetStatus, liveNow, probeWorkers, type Fleet, type FleetMember, type Live, type WorkerProbe } from '../remoteTorrent'
import { useT } from '../i18n/useT'

const REFRESH_MS = 10_000
const LIVE_REFRESH_MS = 3_000

function gib(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`
}

function mbit(bytesPerSecond: number): string {
  return `${(bytesPerSecond / 125_000).toFixed(1)} Mbit/s`
}

function uptime(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86_400)}d`
}

export function FleetStatus() {
  const t = useT()
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [failed, setFailed] = useState(false)
  const [probes, setProbes] = useState<WorkerProbe[]>([])
  const [probing, setProbing] = useState(true)
  const [live, setLive] = useState<Live | null>(null)

  useEffect(() => {
    let disposed = false
    const read = async () => {
      try {
        const next = await fleetStatus()
        if (disposed) return
        setFleet(next)
        setFailed(false)
      } catch {
        if (!disposed) setFailed(true)
      }
    }
    void read()
    const timer = window.setInterval(read, REFRESH_MS)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    let disposed = false
    const read = async () => {
      try {
        const next = await liveNow()
        if (!disposed) setLive(next)
      } catch {}
    }
    void read()
    const timer = window.setInterval(read, LIVE_REFRESH_MS)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    let disposed = false
    void probeWorkers('', (next) => { if (!disposed) setProbes(next) }, { fresh: true })
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
        {live ? (
          <dl className="fleet-live">
            <div>
              <dt>{t('fleet.liveRooms')}</dt>
              <dd><NumberFlow value={live.rooms} /></dd>
            </div>
            <div>
              <dt>{t('fleet.liveMembers')}</dt>
              <dd><NumberFlow value={live.members} /></dd>
            </div>
          </dl>
        ) : null}
        {failed ? <p className="fleet-stale">{t('fleet.stale')}</p> : null}
      </header>

      {workers.length > 0 ? (
        <ol className="fleet-list">
          {workers.map((member, index) => (
            <li key={member.id} className={`fleet-card is-${member.availability}`}>
              <div className="fleet-card-head">
                <code>{member.id.replace(/^w_/, '').slice(0, 8)}</code>
                <span className={`fleet-badge is-${member.availability}`}>{t(`fleet.state.${member.availability}`)}</span>
                {measured && index === 0 && member.availability === 'available' && workers.length > 1
                  ? <span className="fleet-best">{t('fleet.best')}</span>
                  : null}
              </div>
              <Meter label={t('fleet.busy')} value={busyness(member)} detail={busyDetail(member, t)} />
              <dl className="fleet-facts">
                <Fact
                  label={t('fleet.speed')}
                  value={speedLabel(speeds.get(member.id), probing, t)}
                  pending={isMeasuring(speeds.get(member.id), probing)}
                />
                <Fact label={t('fleet.disk')} value={diskLabel(member)} />
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

// Availability first, then fastest as measured from this browser.
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

function diskLabel(member: FleetMember): string {
  const held = member.diskReal ?? member.diskUsed
  return member.diskQuota ? `${gib(held)} / ${gib(member.diskQuota)}` : gib(held)
}

function busiest(member: FleetMember): { key: string; used: number; cap: number; ratio: number } {
  const parts = [
    { key: 'leases', used: member.leases, cap: member.maxLeases ?? 0 },
    { key: 'torrents', used: member.torrents, cap: member.maxTorrents ?? 0 },
    { key: 'disk', used: member.diskUsed, cap: member.diskQuota ?? 0 },
    { key: 'transfer', used: member.transferUsedBps, cap: member.transferCapBps ?? 0 },
  ].map((part) => ({ ...part, ratio: part.cap ? part.used / part.cap : 0 }))
  return parts.reduce((worst, part) => (part.ratio > worst.ratio ? part : worst), parts[0])
}

function busyness(member: FleetMember): number {
  return Math.min(1, Math.max(0, busiest(member).ratio))
}

function busyDetail(member: FleetMember, t: (key: string) => string): string {
  if (member.availability === 'offline') return t('fleet.state.offline')
  const worst = busiest(member)
  if (!worst.cap) return `${member.leases}`
  if (worst.key === 'disk' || worst.key === 'transfer') return t(`fleet.limit.${worst.key}`)
  return `${worst.used} / ${worst.cap} ${t(`fleet.limit.${worst.key}`)}`
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
