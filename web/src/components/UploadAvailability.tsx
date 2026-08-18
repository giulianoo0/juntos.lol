import type { Translator } from '../i18n/useT'
import type { RoomUploadProgress } from '../upload'

const BYTES_PER_MB = 1024 * 1024

function formatMB(bytes: number): string {
  return `${(bytes / BYTES_PER_MB).toFixed(2)} MB`
}

export function UploadAvailability({
  progress,
  t,
}: {
  progress: RoomUploadProgress | null
  t: Translator
}) {
  if (!progress) {
    return (
      <div className="state-card availability-card raised">
        <h1>{t('room.processing')}</h1>
        <p>{t('room.waitingInitial')}</p>
      </div>
    )
  }

  const threshold = Math.max(1, progress.streamStartBytes)
  const received = Math.min(progress.bytesUploaded, threshold)
  const availabilityPct = Math.min(100, Math.round((received / threshold) * 100))

  return (
    <div className="state-card availability-card raised">
      <h1>{t('room.processing')}</h1>
      <p>{availabilityPct === 100 ? t('room.initialReady') : t('room.processingHelp')}</p>
      <div className="availability-meter">
        <div className="progress-copy">
          <span>{t('room.startData')}</span>
          <strong>{availabilityPct}%</strong>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-label={t('room.startData')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={availabilityPct}
        >
          <span style={{ width: `${availabilityPct}%` }} />
        </div>
        <div className="availability-detail">
          <span>{formatMB(received)} / {formatMB(threshold)}</span>
          <span>{t('home.uploading')} {progress.pct}%</span>
        </div>
      </div>
    </div>
  )
}
