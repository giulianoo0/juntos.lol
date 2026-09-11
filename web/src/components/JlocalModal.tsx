import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Download, Gauge, Magnet, Volume2 } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import { connectJLocal, type JLocalSnapshot } from '../jlocal/status'
import { askJLocalScreenPermission, probeJLocalScreenPermission } from '../jlocal/askScreenPermission'
import { Dialog, DialogContent } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { MORPH_EASE } from '../ui/morphTokens'

const JLOCAL_RELEASES_URL = 'https://github.com/giulianoo0/jlocal/releases/latest'

type OS = 'mac' | 'win' | 'linux'

const PLATFORMS: readonly { os: OS; key: string }[] = [
  { os: 'mac', key: 'jlocal.platformMac' },
  { os: 'win', key: 'jlocal.platformWin' },
  { os: 'linux', key: 'jlocal.platformLinux' },
]

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'linux'
  const agent = navigator.userAgent
  if (/windows/i.test(agent)) return 'win'
  if (/mac os|macintosh/i.test(agent)) return 'mac'
  return 'linux'
}

/**
 * What the companion is for and how to get it, in one calm card: that it is
 * optional, said up front; three things it makes better; the download for
 * the system this browser runs on, with the other platforms as plain links
 * underneath. It watches the loopback status, so the card itself says
 * "conectado" the moment the app is up, without the person having to do
 * anything here.
 */
export function JlocalModal({ open, onOpenChange, status, t }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: JLocalSnapshot
  t: Translator
}) {
  const still = useReducedMotion() ?? false
  const os = detectOS()
  const [asking, setAsking] = useState(false)
  // null only while the app is unreachable: a denial answers false, so the
  // retry stays on screen for exactly the people who need it.
  const [granted, setGranted] = useState<boolean | null>(null)
  const [probe, setProbe] = useState(0)
  // macOS only prompts once. After a denial the app can no longer raise the
  // dialog, so the card starts saying where the switch lives.
  const [refused, setRefused] = useState(false)

  useEffect(() => {
    if (!open || !status.connected) { setGranted(null); setRefused(false); return }
    let cancelled = false
    void probeJLocalScreenPermission().then((value) => { if (!cancelled) setGranted(value) })
    return () => { cancelled = true }
  }, [open, status.connected, probe])

  const fade = still ? { duration: 0 } : { duration: 0.28, ease: MORPH_EASE }
  const perks = [
    { icon: <Gauge size={16} aria-hidden="true" />, text: t('jlocal.perkQuality') },
    { icon: <Volume2 size={16} aria-hidden="true" />, text: t('jlocal.perkSound') },
    { icon: <Magnet size={16} aria-hidden="true" />, text: t('jlocal.perkTorrent') },
  ]
  const description = <>{t('jlocal.modalGuide')} <strong>{t('jlocal.modalOptional')}</strong></>
  // Only for the app that is up but blocked: it re-probes the loopback and
  // brings the Screen Recording prompt back up, which nothing the site polls
  // ever asks for. Granted (or unknown), the card stays as it was.
  const already = granted === false ? (
    <Button variant="ghost" disabled={asking} onClick={() => {
      setAsking(true)
      connectJLocal()
      void askJLocalScreenPermission()
        .then((ok) => { if (!ok) setRefused(true) })
        .finally(() => { setAsking(false); setProbe((n) => n + 1) })
    }}>
      {t(asking ? 'jlocal.alreadyAsking' : refused ? 'jlocal.alreadyRetry' : 'jlocal.already')}
    </Button>
  ) : null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="jget-dialog" title={t('jlocal.modalTitle')} description={description} closeLabel={t('home.closeDialog')}>
        <ul className="jget-perks">
          {perks.map((perk, index) => (
            <motion.li
              key={index}
              initial={still ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...fade, delay: still ? 0 : 0.05 + index * 0.06 }}
            >
              <span className="jget-perk-icon">{perk.icon}</span>{perk.text}
            </motion.li>
          ))}
        </ul>
        <ol className="jget-steps">
          <li>{t('jlocal.stepGet')}</li>
          <li>{t(os === 'mac' ? 'jlocal.stepOpenMac' : os === 'win' ? 'jlocal.stepOpenWin' : 'jlocal.stepOpenLinux')}</li>
          <li>{t('jlocal.stepConnect')}</li>
        </ol>
        {granted === false && refused ? <p className="jget-blocked">{t('jlocal.permission')}</p> : null}
        <AnimatePresence mode="wait" initial={false}>
          {status.connected ? (
            <motion.div key="on" className="jget-actions" initial={still ? false : { opacity: 0, filter: 'blur(4px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, filter: 'blur(4px)' }} transition={fade}>
              <span className="jget-connected"><Check size={15} aria-hidden="true" />{t('jlocal.connectedNow')}{status.version ? ` · ${status.version}` : ''}</span>
              <span className="spacer" />
              {already}
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('home.closeDialog')}</Button>
            </motion.div>
          ) : (
            <motion.div key="off" initial={still ? false : { opacity: 0, filter: 'blur(4px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, filter: 'blur(4px)' }} transition={fade}>
              <div className="jget-actions">
                <Button variant="primary" asChild>
                  <a href={JLOCAL_RELEASES_URL} target="_blank" rel="noreferrer">
                    <Download size={15} aria-hidden="true" />{t(os === 'mac' ? 'jlocal.downloadMac' : os === 'win' ? 'jlocal.downloadWin' : 'jlocal.downloadLinux')}
                  </a>
                </Button>
                {already}
                <span className="spacer" />
                <span className="jget-waiting"><span className="jlocal-dot" aria-hidden="true" />{t('jlocal.waiting')}</span>
              </div>
              <p className="jget-platforms">
                {t('jlocal.otherSystems')}
                {PLATFORMS.filter((platform) => platform.os !== os).map((platform, index) => (
                  <span key={platform.os}>
                    {index > 0 ? <span className="jget-platforms-sep" aria-hidden="true"> · </span> : ' '}
                    <a href={JLOCAL_RELEASES_URL} target="_blank" rel="noreferrer">{t(platform.key)}</a>
                  </span>
                ))}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  )
}
