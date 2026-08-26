/**
 * The way out of "unsupported media".
 *
 * A verdict with no evidence is not something a person can act on or report.
 * This gathers what actually decided it — the pipeline's own reason, the
 * codecs this browser will decode, the state of the room and its swarm — and
 * puts it on the clipboard in one press.
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
      // No clipboard permission, or an insecure context. The report is still
      // worth having, so it goes somewhere it can be read and selected.
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
