import { useEffect, useLayoutEffect, useRef } from 'react'
import { useT } from '../i18n/useT'
import { connectFrame, dressFrame, type Bridge, type LoadedExtension } from './bridge'
import type { ExtToHost, ExtensionPlace } from './protocol'
import { useThemeTokens } from './theme'

interface ExtensionFrameProps {
  extension: LoadedExtension
  place?: ExtensionPlace
  canPlay: boolean
  onMessage: (message: ExtToHost) => void
  className?: string
}

/** One extension, in its own origin, talking only through the protocol. */
export function ExtensionFrame({ extension, place, canPlay, onMessage, className }: ExtensionFrameProps) {
  const t = useT()
  const theme = useThemeTokens()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const bridgeRef = useRef<Bridge | null>(null)
  const latest = useRef({ theme, locale: t.language as string, canPlay, onMessage })
  useLayoutEffect(() => {
    latest.current = { theme, locale: t.language, canPlay, onMessage }
  })

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const bridge = connectFrame(
      frame,
      extension,
      place,
      () => ({ theme: latest.current.theme, locale: latest.current.locale, canPlay: latest.current.canPlay }),
      (message) => latest.current.onMessage(message),
    )
    bridgeRef.current = bridge
    dressFrame(frame, extension, place)
    return () => { bridge.close(); bridgeRef.current = null }
  }, [extension, place])

  useEffect(() => {
    bridgeRef.current?.post({ juntos: 1, type: 'theme', theme })
  }, [theme])

  return <iframe ref={frameRef} className={className} title={extension.manifest.name} />
}
