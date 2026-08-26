import { useEffect, useState } from 'react'
import { fleetStatus, type Fleet, type FleetMember } from '../remoteTorrent'
import { useT } from '../i18n/useT'

// The fleet moves on ten-second heartbeats, so anything faster would redraw
// the same numbers; anything much slower and the page is describing a fleet
// that has moved on.
const REFRESH_MS = 10_000

function gib(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(1)} GB`
}

function mbit(bps: number): string {
  return `${(bps / 1_000_000).toFixed(1)} Mbit/s`
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

      {fleet.workers.length > 0 ? (
        <ol className="fleet-list">
          {fleet.workers.map((member, index) => (
            <li key={member.id} className={`fleet-card is-${member.availability}`}>
              <div className="fleet-card-head">
                <code>{member.id.replace(/^w_/, '').slice(0, 8)}</code>
                <span className={`fleet-badge is-${member.availability}`}>{t(`fleet.state.${member.availability}`)}</span>
                {/* Only worth pointing out where it changes a decision: the
                    head of a list of one is not news. */}
                {index === 0 && member.availability === 'available' && fleet.workers.length > 1
                  ? <span className="fleet-best">{t('fleet.best')}</span>
                  : null}
              </div>
              <Meter label={t('fleet.busy')} value={busyness(member)} detail={busyDetail(member, t)} />
              <dl className="fleet-facts">
                {member.diskQuota ? (
                  <div>
                    <dt>{t('fleet.disk')}</dt>
                    <dd>{gib(member.diskUsed)} / {gib(member.diskQuota)}</dd>
                  </div>
                ) : null}
                {member.transferCapBps ? (
                  <div>
                    <dt>{t('fleet.transfer')}</dt>
                    <dd>{mbit(member.transferUsedBps)} / {mbit(member.transferCapBps)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{t('fleet.torrents')}</dt>
                  <dd>{member.maxTorrents ? `${member.torrents} / ${member.maxTorrents}` : member.torrents}</dd>
                </div>
                {member.uptimeSecs ? (
                  <div>
                    <dt>{t('fleet.uptime')}</dt>
                    <dd>{uptime(member.uptimeSecs)}</dd>
                  </div>
                ) : null}
                {member.version ? (
                  <div>
                    <dt>{t('fleet.version')}</dt>
                    <dd>{member.version}</dd>
                  </div>
                ) : null}
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
