import NumberFlow from '@number-flow/react'
import { useT } from '../i18n/useT'
import type { TorrentStats } from '../torrent'

/**
 * What the swarm is doing, while the room is being built out of it.
 *
 * The wait here is the torrent's, not the app's: the remux reads the file
 * through the helper and blocks until those bytes have downloaded, so the
 * whole preparing state moves at whatever the peers are giving. Without these
 * numbers a slow swarm and a hung app look identical, and the only thing on
 * screen is a spinner that has been turning for four minutes.
 *
 * It renders wherever that wait shows: the starting overlay on Home, and the
 * room's own preparing screen — on the host's machine, which is the only one
 * that has a swarm to read.
 */
export function TorrentReadout({ stats }: { stats: TorrentStats }) {
  const t = useT()
  return (
    <dl className="starting-swarm">
      <div>
        <dt>{t('home.swarmPeers')}</dt>
        <dd><NumberFlow value={stats.peers} /></dd>
      </div>
      <div>
        <dt>{t('home.swarmSpeed')}</dt>
        <dd><NumberFlow value={round(stats.downloadSpeed / 1_048_576, 1)} suffix=" MB/s" /></dd>
      </div>
      <div>
        <dt>{t('home.swarmDownloaded')}</dt>
        <dd><NumberFlow value={round(stats.downloaded / 1_073_741_824, 2)} suffix=" GB" /></dd>
      </div>
    </dl>
  )
}

// NumberFlow animates between the values it is handed, so feeding it the raw
// float would roll every decimal place on every poll.
const round = (value: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
