import type { ComponentProps } from 'react'
import type { unstable_HistoryRouter as HistoryRouter } from 'react-router-dom'

export type History = ComponentProps<typeof HistoryRouter>['history']
type Listener = Parameters<History['listen']>[0]

/**
 * The browser's history, with back and forward handed to the router a task
 * after the popstate event. React finishes any update made during popstate
 * at once, outside the transition the router asks for, and so with no view
 * transition: the logo jumped on back and forward while it morphed on a
 * click. Out of the event, they morph like any link.
 */
export function deferPops(history: History): History {
  return Object.create(history, {
    listen: {
      value: (listener: Listener) => {
        let listening = true
        const stop = history.listen((update) => {
          if (update.action === 'POP') setTimeout(() => { if (listening) listener(update) })
          else listener(update)
        })
        return () => {
          listening = false
          stop()
        }
      },
    },
  }) as History
}
