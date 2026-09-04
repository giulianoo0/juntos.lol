import { motion, useReducedMotion } from 'motion/react'
import { Play, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import type { MetaVideo } from './tmdb'
import { FadeImg } from './FadeImg'

interface NextEpisodeCardProps {
  video: MetaVideo
  poster: string
  seconds: number
  onPlayNow: () => void
  onDismiss: () => void
}

export function NextEpisodeCard({ video, poster, seconds, onPlayNow, onDismiss }: NextEpisodeCardProps) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      className="next-episode-card"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(12px)' }}
      animate={{ opacity: 1, transform: 'translateY(0px)' }}
      transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
      role="status"
    >
      {video.thumbnail || poster ? (
        <FadeImg className="next-episode-art" src={video.thumbnail || poster} alt="" />
      ) : null}
      <div className="next-episode-copy">
        <span className="next-episode-kicker">{t('next.upNext')}</span>
        <strong>E{video.episode} {video.name || ''}</strong>
        <span className="next-episode-count">{t('next.playingIn')} {seconds}s</span>
        <button type="button" className="next-episode-play" onClick={onPlayNow}>
          <Play size={12} aria-hidden="true" />{t('next.playNow')}
        </button>
      </div>
      <button type="button" className="dialog-close next-episode-dismiss" aria-label={t('next.cancel')} onClick={onDismiss}>
        <X size={13} aria-hidden="true" />
      </button>
    </motion.div>
  )
}
