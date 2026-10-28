// What /api/data answers, and the numbers the page draws from it. Totals
// only: the server never sends who.

export type Metrics = Record<string, number>

export interface DataReport {
  generatedAt: string
  now: { rooms: number; members: number; roomsByState?: Record<string, number> }
  fleet: {
    online: number
    total: number
    torrents: number
    leases: number
    diskUsed: number
    diskQuota: number
    transferUsedBps: number
    transferCapBps: number
  }
  accounts?: {
    total: number
    public: number
    signedIn: number
    friendships: number
    watches: number
    watchedSeconds: number
    watchesByKind: Record<string, number>
    newByDay: Record<string, number>
  }
  days: { day: string; metrics: Metrics }[]
}

export async function fetchReport(signal?: AbortSignal): Promise<DataReport> {
  const response = await fetch('/api/data', { signal })
  if (!response.ok) throw new Error(`data ${response.status}`)
  return await response.json() as DataReport
}

/** One day of a series; null where the day has nothing to average. */
export type Point = { day: string; value: number | null }

const GB = 1024 ** 3

function ratio(top: number | undefined, bottom: number | undefined, scale = 1): number | null {
  return bottom ? (top ?? 0) / bottom / scale : null
}

/** A chart's whole period in one number, weighted where the days are ratios. */
type Headline = (days: { day: string; metrics: Metrics }[], points: Point[]) => number | null

const sum: Headline = (_, points) => points.reduce((total, point) => total + (point.value ?? 0), 0)
// Only days the site was counting: the ones before it began have no metrics
// at all and would drag the average to nothing.
const mean: Headline = (days, points) => {
  const values = points.filter((point, i) => point.value !== null && Object.keys(days[i].metrics).length > 0)
    .map((point) => point.value as number)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}
const peak: Headline = (_, points) => Math.max(0, ...points.map((point) => point.value ?? 0))
const weighted = (top: string, bottom: string, scale = 1): Headline => (days) => {
  const totalTop = days.reduce((total, day) => total + (day.metrics[top] ?? 0), 0)
  const totalBottom = days.reduce((total, day) => total + (day.metrics[bottom] ?? 0), 0)
  return ratio(totalTop, totalBottom, scale)
}

export type Unit = 'count' | 'minutes' | 'mbps' | 'gb' | 'ratio'

export interface SeriesSpec {
  key: string
  unit: Unit
  value: (metrics: Metrics, day: string, report: DataReport) => number | null
  headline: Headline
}

export const SERIES: readonly SeriesSpec[] = [
  { key: 'visitors', unit: 'count', value: (m) => m.visitors ?? 0, headline: mean },
  { key: 'roomsCreated', unit: 'count', value: (m) => m.rooms_created ?? 0, headline: sum },
  { key: 'roomPeople', unit: 'count', value: (m) => m.room_people ?? 0, headline: mean },
  { key: 'avgStay', unit: 'minutes', value: (m) => ratio(m.room_seconds, m.room_sessions, 60), headline: weighted('room_seconds', 'room_sessions', 60) },
  { key: 'peak', unit: 'count', value: (m) => m.peak_members ?? 0, headline: peak },
  { key: 'newAccounts', unit: 'count', value: (_, day, report) => report.accounts?.newByDay[day] ?? 0, headline: sum },
  { key: 'viewerBandwidth', unit: 'mbps', value: (m) => ratio(m.viewer_kbps_sum, m.viewer_kbps_n, 1000), headline: weighted('viewer_kbps_sum', 'viewer_kbps_n', 1000) },
  { key: 'mediaBitrate', unit: 'mbps', value: (m) => ratio(m.media_kbps_sum, m.media_kbps_n, 1000), headline: weighted('media_kbps_sum', 'media_kbps_n', 1000) },
  { key: 'stalls', unit: 'ratio', value: (m) => ratio(m.stalls, m.room_sessions), headline: weighted('stalls', 'room_sessions') },
  { key: 'torrentBytes', unit: 'gb', value: (m) => (m.torrent_bytes ?? 0) / GB, headline: sum },
  { key: 'torrents', unit: 'count', value: (m) => m.torrents ?? 0, headline: sum },
  { key: 'torrentFile', unit: 'gb', value: (m) => ratio(m.torrent_file_bytes, m.torrent_plays, GB), headline: weighted('torrent_file_bytes', 'torrent_plays', GB) },
  { key: 'youtube', unit: 'count', value: (m) => m.youtube ?? 0, headline: sum },
  { key: 'sources', unit: 'count', value: (m) => m.sources ?? 0, headline: sum },
]

export interface Series {
  spec: SeriesSpec
  points: Point[]
  headline: number | null
}

/** Every chart over the last `span` days, today last. */
export function seriesOf(report: DataReport, span: number): Series[] {
  const days = report.days.slice(-span)
  return SERIES.map((spec) => {
    const points = days.map(({ day, metrics }) => ({ day, value: spec.value(metrics, day, report) }))
    return { spec, points, headline: spec.headline(days, points) }
  })
}

/** Sums the metrics that start with prefix over the last `span` days, by what follows it. */
export function breakdown(report: DataReport, span: number, prefix: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const { metrics } of report.days.slice(-span)) {
    for (const [name, value] of Object.entries(metrics)) {
      if (name.startsWith(prefix)) out[name.slice(prefix.length)] = (out[name.slice(prefix.length)] ?? 0) + value
    }
  }
  return out
}
