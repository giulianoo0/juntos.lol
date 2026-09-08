import NumberFlow from '@number-flow/react'
import { numbersAnimate } from '../engine'
import { useT } from '../i18n/useT'
import type { TorrentStats } from '../torrent'

export function TorrentReadout({ stats }: { stats: TorrentStats }) {
  const t = useT()
  return (
    <dl className="starting-swarm">
      <div>
        <dt>{t('home.swarmPeers')}</dt>
        <dd><NumberFlow animated={numbersAnimate} value={stats.peers} /></dd>
      </div>
      <div>
        <dt>{t('home.swarmSpeed')}</dt>
        <dd><NumberFlow animated={numbersAnimate} value={round(stats.downloadSpeed / 1_048_576, 1)} suffix=" MB/s" /></dd>
      </div>
      <div>
        <dt>{t('home.swarmDownloaded')}</dt>
        <dd><NumberFlow animated={numbersAnimate} value={round(stats.downloaded / 1_073_741_824, 2)} suffix=" GB" /></dd>
      </div>
      {stats.diskBytes !== undefined ? (
        <div>
          <dt>{t('home.swarmOnDisk')}</dt>
          <dd><NumberFlow animated={numbersAnimate} value={round(stats.diskBytes / 1_048_576, 0)} suffix=" MB" /></dd>
        </div>
      ) : null}
    </dl>
  )
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
