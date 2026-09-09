import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Download, Gauge, Magnet, Volume2 } from 'lucide-react'
import type { Translator } from '../i18n/useT'
import type { JLocalSnapshot } from '../jlocal/status'
import { Dialog, DialogContent } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { MORPH_EASE } from '../ui/morphTokens'

const JLOCAL_RELEASES_URL = 'https://github.com/giulianoo0/jlocal/releases/latest'

type OS = 'mac' | 'win' | 'linux'

function detectOS(): OS {
  if (typeof navigator === 'undefined') return 'linux'
  const agent = navigator.userAgent
  if (/windows/i.test(agent)) return 'win'
  if (/mac os|macintosh/i.test(agent)) return 'mac'
  return 'linux'
}

/**
 * What the companion is for and how to get it, in one calm card: three
 * things it makes better, the download for the system this browser runs on,
 * and the reassurance that everything works without it. It watches the
 * loopback status, so the card itself says "conectado" the moment the app
 * is up, without the person having to do anything here.
 */
export function JlocalModal({ open, onOpenChange, status, t }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: JLocalSnapshot
  t: Translator
}) {
  const still = useReducedMotion() ?? false
  const os = detectOS()
  const fade = still ? { duration: 0 } : { duration: 0.28, ease: MORPH_EASE }
  const perks = [
    { icon: <Gauge size={16} aria-hidden="true" />, text: t('jlocal.perkQuality') },
    { icon: <Volume2 size={16} aria-hidden="true" />, text: t('jlocal.perkSound') },
    { icon: <Magnet size={16} aria-hidden="true" />, text: t('jlocal.perkTorrent') },
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="jget-dialog" title={t('jlocal.modalTitle')} description={t('jlocal.modalGuide')} closeLabel={t('home.closeDialog')}>
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
        <AnimatePresence mode="wait" initial={false}>
          {status.connected ? (
            <motion.div key="on" className="jget-actions" initial={still ? false : { opacity: 0, filter: 'blur(4px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, filter: 'blur(4px)' }} transition={fade}>
              <span className="jget-connected"><Check size={15} aria-hidden="true" />{t('jlocal.connectedNow')}{status.version ? ` · ${status.version}` : ''}</span>
              <span className="spacer" />
              <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('home.closeDialog')}</Button>
            </motion.div>
          ) : (
            <motion.div key="off" className="jget-actions" initial={still ? false : { opacity: 0, filter: 'blur(4px)' }} animate={{ opacity: 1, filter: 'blur(0px)' }} exit={{ opacity: 0, filter: 'blur(4px)' }} transition={fade}>
              <Button variant="primary" asChild>
                <a href={JLOCAL_RELEASES_URL} target="_blank" rel="noreferrer">
                  <Download size={15} aria-hidden="true" />{t(os === 'mac' ? 'jlocal.downloadMac' : os === 'win' ? 'jlocal.downloadWin' : 'jlocal.downloadLinux')}
                </a>
              </Button>
              <Button variant="ghost" asChild>
                <a href={JLOCAL_RELEASES_URL} target="_blank" rel="noreferrer">{t('jlocal.otherSystems')}</a>
              </Button>
              <span className="spacer" />
              <span className="jget-waiting"><span className="jlocal-dot" aria-hidden="true" />{t('jlocal.waiting')}</span>
            </motion.div>
          )}
        </AnimatePresence>
        <p className="jget-optional">{t('jlocal.modalOptional')}</p>
      </DialogContent>
    </Dialog>
  )
}
