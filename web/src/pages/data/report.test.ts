import { describe, expect, it } from 'vitest'
import { breakdown, seriesOf, type DataReport } from './report'

function reportOf(days: DataReport['days'], newByDay: Record<string, number> = {}): DataReport {
  return {
    generatedAt: '2026-10-28T12:00:00Z',
    now: { rooms: 0, members: 0 },
    fleet: { online: 0, total: 0, torrents: 0, leases: 0, diskUsed: 0, diskQuota: 0, transferUsedBps: 0, transferCapBps: 0 },
    accounts: { total: 0, public: 0, signedIn: 0, friendships: 0, watches: 0, watchedSeconds: 0, watchesByKind: {}, newByDay },
    days,
  }
}

const series = (report: DataReport, span: number, key: string) => seriesOf(report, span).find((s) => s.spec.key === key)!

describe('seriesOf', () => {
  it('tempo médio do período pesa pelas sessões, não pela média dos dias', () => {
    const report = reportOf([
      { day: '2026-10-27', metrics: { room_sessions: 1, room_seconds: 60 * 60 } },
      { day: '2026-10-28', metrics: { room_sessions: 9, room_seconds: 9 * 10 * 60 } },
    ])
    const stay = series(report, 7, 'avgStay')
    expect(stay.points.map((p) => p.value)).toEqual([60, 10])
    expect(stay.headline).toBe(15)
  })

  it('dia sem sessão não tem média, em vez de zero', () => {
    const report = reportOf([{ day: '2026-10-28', metrics: {} }])
    expect(series(report, 7, 'avgStay').points[0].value).toBeNull()
    expect(series(report, 7, 'avgStay').headline).toBeNull()
  })

  it('o período corta pelos últimos dias e as contas novas vêm do recenseamento', () => {
    const report = reportOf([
      { day: '2026-10-26', metrics: { rooms_created: 5 } },
      { day: '2026-10-27', metrics: { rooms_created: 2 } },
      { day: '2026-10-28', metrics: { rooms_created: 1 } },
    ], { '2026-10-28': 3, '2026-10-26': 4 })
    expect(series(report, 2, 'roomsCreated').headline).toBe(3)
    expect(series(report, 2, 'newAccounts').headline).toBe(3)
  })
})

describe('breakdown', () => {
  it('soma os aparelhos dos dias do período', () => {
    const report = reportOf([
      { day: '2026-10-27', metrics: { device_iphone: 2, device_desktop: 1, visits: 9 } },
      { day: '2026-10-28', metrics: { device_iphone: 1 } },
    ])
    expect(breakdown(report, 7, 'device_')).toEqual({ iphone: 3, desktop: 1 })
  })
})
