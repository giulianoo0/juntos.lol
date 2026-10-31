/**
 * The way out of "unsupported media": puts what decided it (the pipeline's
 * reason, the codecs this browser decodes, the room and its swarm) on the
 * clipboard in one press.
 */
import { useState } from 'react'
import { buildDiagnostics } from '../diagnostics'
import type { Translator } from '../i18n/useT'
import type { RoomInfo } from '../types'

type State = 'idle' | 'done' | 'failed'

export function CopyErrorReport({ room, failure, detail, t }: {
  room: RoomInfo
  failure: string | null
  detail: string | null
  t: Translator
}) {
  const [state, setState] = useState<State>('idle')

  const copy = async () => {
    const report = await buildDiagnostics({ room, failure, detail })
    try {
      await navigator.clipboard.writeText(report)
      setState('done')
    } catch {
      console.error(report)
      setState('failed')
    }
    setTimeout(() => setState('idle'), 4000)
  }

  return (
    <div className="copy-report">
      <button type="button" className="ghost-button" onClick={() => { void copy() }}>
        {state === 'done' ? t('room.copyReportDone')
          : state === 'failed' ? t('room.copyReportFailed')
          : t('room.copyReport')}
      </button>
      <small>{t('room.copyReportHint')}</small>
    </div>
  )
}
