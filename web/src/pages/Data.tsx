import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { SiteHeader } from '../components/SiteHeader'
import { useT, type Translator } from '../i18n/useT'
import { Pill } from '../ui/Pill'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Shimmer'
import { breakdown, fetchReport, seriesOf, type DataReport, type Series, type Unit } from './data/report'
import styles from './Data.module.css'

const REFRESH_MS = 30_000
const SPANS = ['7', '30', '90'] as const
type Span = typeof SPANS[number]

function useReport() {
  const [report, setReport] = useState<DataReport | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const load = () => {
      if (document.visibilityState === 'hidden') return
      fetchReport(controller.signal).then((next) => {
        setReport(next)
        setFailed(false)
      }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [attempt])
  return { report, failed, retry: () => setAttempt((n) => n + 1) }
}

function formatter(t: Translator) {
  const number = (digits: number) => new Intl.NumberFormat(t.language, { maximumFractionDigits: digits, minimumFractionDigits: digits })
  const whole = number(0)
  const one = number(1)
  const two = number(2)
  return (value: number | null, unit: Unit): string => {
    if (value === null) return '–'
    switch (unit) {
      case 'count': return whole.format(Math.round(value))
      case 'minutes': return `${one.format(value)} min`
      case 'mbps': return `${one.format(value)} Mb/s`
      case 'gb': return `${(value >= 10 ? one : two).format(value)} GB`
      case 'ratio': return two.format(value)
    }
  }
}

function bytes(t: Translator, n: number): string {
  const format = new Intl.NumberFormat(t.language, { maximumFractionDigits: 1 })
  if (n >= 1024 ** 4) return `${format.format(n / 1024 ** 4)} TB`
  if (n >= 1024 ** 3) return `${format.format(n / 1024 ** 3)} GB`
  return `${format.format(n / 1024 ** 2)} MB`
}

function dayLabel(t: Translator, day: string): string {
  return new Intl.DateTimeFormat(t.language, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`))
}

/** One metric across the days: the period's number, and a bar per day that names itself under the pointer. */
function Chart({ series, t, format }: { series: Series; t: Translator; format: ReturnType<typeof formatter> }) {
  const [active, setActive] = useState<number | null>(null)
  const { points, spec } = series
  const top = Math.max(0, ...points.map((point) => point.value ?? 0))
  const last = points.length - 1
  const shown = active === null ? series.headline : points[active]?.value ?? null
  const qualifier = active === null
    ? t(`data.headline.${spec.key}`)
    : active === last ? t('data.today') : dayLabel(t, points[active].day)
  const empty = top === 0

  const pick = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const index = Math.floor(((event.clientX - box.left) / box.width) * points.length)
    setActive(Math.min(last, Math.max(0, index)))
  }
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const from = active ?? last
    setActive(Math.min(last, Math.max(0, from + (event.key === 'ArrowLeft' ? -1 : 1))))
  }

  return (
    <section className={styles.chart}>
      <h3 className={styles.chartTitle}>{t(`data.series.${spec.key}`)}</h3>
      <p className={styles.readout} aria-live="polite">
        <span className={styles.readoutValue}>{format(shown, spec.unit)}</span>
        <span className={styles.readoutWhen}>{qualifier}</span>
      </p>
      <div
        className={styles.plot}
        data-active={active === null ? undefined : ''}
        role="img"
        aria-label={`${t(`data.series.${spec.key}`)}: ${format(series.headline, spec.unit)}`}
        tabIndex={0}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={step}
      >
        {empty ? <span className={styles.nothing}>{t('data.nothing')}</span> : null}
        {!empty ? <span className={styles.top}>{format(top, spec.unit)}</span> : null}
        {points.map((point, index) => (
          <span
            key={point.day}
            className={styles.bar}
            data-on={index === active ? '' : undefined}
            data-today={index === last ? '' : undefined}
          >
            <span className={styles.fill} style={{ height: `${top ? ((point.value ?? 0) / top) * 100 : 0}%` }} />
          </span>
        ))}
      </div>
      <div className={styles.axis} aria-hidden="true">
        <span>{points[0] ? dayLabel(t, points[0].day) : ''}</span>
        <span>{t('data.today')}</span>
      </div>
    </section>
  )
}

/** A part's own word, or its raw name for one the page does not know yet. */
function partName(t: Translator, name: string): string {
  const key = `data.part.${name}`
  const word = t(key)
  return word === key ? name : word
}

/** Parts of a whole, largest first, each with its share. */
function Breakdown({ title, parts, t }: { title: string; parts: Record<string, number>; t: Translator }) {
  const entries = Object.entries(parts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  const percent = new Intl.NumberFormat(t.language, { style: 'percent', maximumFractionDigits: 0 })
  const whole = new Intl.NumberFormat(t.language)
  return (
    <section className={styles.panel}>
      <h3 className={styles.chartTitle}>{title}</h3>
      {entries.length === 0 ? <p className={styles.quiet}>{t('data.nothing')}</p> : (
        <ul className={styles.parts}>
          {entries.map(([name, n]) => (
            <li key={name} className={styles.part}>
              <span className={styles.partName}>{partName(t, name)}</span>
              <span className={styles.partValue}>{whole.format(n)} · {percent.format(n / total)}</span>
              <span className={styles.share} aria-hidden="true"><span style={{ width: `${(n / total) * 100}%` }} /></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Meter({ label, used, cap, text }: { label: string; used: number; cap: number; text: string }) {
  return (
    <div className={styles.meter}>
      <div className={styles.meterHead}>
        <span>{label}</span>
        <span className={styles.meterValue}>{text}</span>
      </div>
      <span className={styles.share} aria-hidden="true"><span style={{ width: `${cap ? Math.min(100, (used / cap) * 100) : 0}%` }} /></span>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.stat}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

/** juntos.lol/data: how the site is used, in totals, out in the open. */
export function DataPage() {
  const t = useT()
  const { report, failed, retry } = useReport()
  const [span, setSpan] = useState<Span>(() => window.matchMedia?.('(max-width: 40rem)').matches ? '30' : '90')
  const format = useMemo(() => formatter(t), [t])
  const whole = useMemo(() => new Intl.NumberFormat(t.language), [t])
  const series = useMemo(() => report ? seriesOf(report, Number(span)) : [], [report, span])

  useEffect(() => {
    document.title = `${t('data.title')} · juntos`
  }, [t])

  return (
    <div className={styles.page}>
      <SiteHeader />
      <main className={styles.main}>
        <div className={styles.head}>
          <h1 className={styles.title}>{t('data.title')}</h1>
          <Segmented
            label={t('data.span')}
            options={SPANS.map((value) => ({ value, label: t(`data.span.${value}`) }))}
            value={span}
            onChange={setSpan}
          />
        </div>

        {report === null && failed ? (
          <div className={styles.failed} role="alert">
            <p>{t('data.failed')}</p>
            <Pill tone="soft" size="md" onClick={retry}>{t('data.retry')}</Pill>
          </div>
        ) : report === null ? (
          <div className={styles.grid}>
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height="14rem" className={styles.skeleton} />)}
          </div>
        ) : (
          <>
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('data.now')}</h2>
              <dl className={styles.stats}>
                <Stat label={t('data.now.members')} value={whole.format(report.now.members)} />
                <Stat label={t('data.now.rooms')} value={whole.format(report.now.rooms)} />
                <Stat label={t('data.now.open')} value={whole.format(Object.values(report.now.roomsByState ?? {}).reduce((a, b) => a + b, 0))} />
                <Stat label={t('data.now.workers')} value={`${whole.format(report.fleet.online)}/${whole.format(report.fleet.total)}`} />
              </dl>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('data.people')}</h2>
              <div className={styles.grid}>
                {series.filter((s) => ['visitors', 'roomPeople', 'roomsCreated', 'avgStay', 'peak', 'sources'].includes(s.spec.key))
                  .map((s) => <Chart key={s.spec.key} series={s} t={t} format={format} />)}
              </div>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('data.accounts')}</h2>
              {report.accounts ? (
                <dl className={styles.stats}>
                  <Stat label={t('data.accounts.total')} value={whole.format(report.accounts.total)} />
                  <Stat label={t('data.accounts.signedIn')} value={whole.format(report.accounts.signedIn)} />
                  <Stat label={t('data.accounts.public')} value={whole.format(report.accounts.public)} />
                  <Stat label={t('data.accounts.friendships')} value={whole.format(report.accounts.friendships)} />
                  <Stat label={t('data.accounts.hours')} value={whole.format(Math.round(report.accounts.watchedSeconds / 3600))} />
                </dl>
              ) : null}
              <div className={styles.grid}>
                {series.filter((s) => s.spec.key === 'newAccounts').map((s) => <Chart key={s.spec.key} series={s} t={t} format={format} />)}
                {report.accounts ? <Breakdown title={t('data.watchesByKind')} parts={report.accounts.watchesByKind} t={t} /> : null}
              </div>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('data.bandwidth')}</h2>
              <div className={styles.grid}>
                {series.filter((s) => ['viewerBandwidth', 'mediaBitrate', 'stalls'].includes(s.spec.key))
                  .map((s) => <Chart key={s.spec.key} series={s} t={t} format={format} />)}
                <Breakdown title={t('data.devices')} parts={breakdown(report, Number(span), 'device_')} t={t} />
              </div>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('data.torrent')}</h2>
              <div className={styles.grid}>
                {series.filter((s) => ['torrentBytes', 'torrents', 'torrentFile', 'youtube'].includes(s.spec.key))
                  .map((s) => <Chart key={s.spec.key} series={s} t={t} format={format} />)}
                <section className={styles.panel}>
                  <h3 className={styles.chartTitle}>{t('data.fleet')}</h3>
                  <Meter label={t('data.fleet.disk')} used={report.fleet.diskUsed} cap={report.fleet.diskQuota}
                    text={report.fleet.diskQuota ? `${bytes(t, report.fleet.diskUsed)} / ${bytes(t, report.fleet.diskQuota)}` : bytes(t, report.fleet.diskUsed)} />
                  <Meter label={t('data.fleet.transfer')} used={report.fleet.transferUsedBps} cap={report.fleet.transferCapBps}
                    text={`${format(report.fleet.transferUsedBps * 8 / 1e6, 'mbps')}${report.fleet.transferCapBps ? ` / ${format(report.fleet.transferCapBps * 8 / 1e6, 'mbps')}` : ''}`} />
                  <dl className={styles.pairs}>
                    <div><dt>{t('data.fleet.torrents')}</dt><dd>{whole.format(report.fleet.torrents)}</dd></div>
                    <div><dt>{t('data.fleet.leases')}</dt><dd>{whole.format(report.fleet.leases)}</dd></div>
                  </dl>
                </section>
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  )
}
