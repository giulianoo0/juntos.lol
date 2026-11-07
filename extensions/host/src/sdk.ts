export interface ThemeTokens {
  mode: 'dark' | 'light'
  vars: Record<string, string>
}
export type ExtSource = { kind: 'hls' | 'file'; url: string }
export interface InitMessage {
  juntos: 1
  type: 'init'
  theme: ThemeTokens
  locale: string
  canPlay: boolean
}
export interface PlayRequest {
  title: string
  subtitle?: string
  poster?: string
  ref: string
  source: ExtSource
}

type SdkWindow = Pick<Window, 'parent' | 'document' | 'addEventListener'> & {
  location: { ancestorOrigins?: ArrayLike<string> }
}

const VAR_NAME = /^--[A-Za-z0-9_-]{1,64}$/
const VAR_VALUE = /^[^;{}<>]{0,64}$/

function isTheme(v: unknown): v is ThemeTokens {
  if (!v || typeof v !== 'object') return false
  const t = v as ThemeTokens
  return (t.mode === 'dark' || t.mode === 'light') && !!t.vars && typeof t.vars === 'object' && !Array.isArray(t.vars)
}

export function installJuntos(win: SdkWindow, origins: string[]) {
  let parentOrigin: string | null = null
  let init: InitMessage | null = null
  const initCbs: ((i: InitMessage) => void)[] = []
  const themeCbs: ((t: ThemeTokens) => void)[] = []
  let refreshCb: ((ref: string) => Promise<ExtSource | null>) | null = null

  function applyTheme(t: ThemeTokens) {
    const root = win.document.documentElement
    for (const [k, v] of Object.entries(t.vars)) {
      if (VAR_NAME.test(k) && typeof v === 'string' && VAR_VALUE.test(v)) root.style.setProperty(k, v)
    }
    root.setAttribute('data-theme', t.mode)
  }

  function post(msg: Record<string, unknown>) {
    const data = { ...msg, juntos: 1 }
    const ancestor = win.location.ancestorOrigins?.[0]
    const targets = parentOrigin ? [parentOrigin] : ancestor && origins.includes(ancestor) ? [ancestor] : origins
    for (const o of targets) win.parent.postMessage(data, o)
  }

  async function answerRefresh(nonce: string, ref: string) {
    let source: ExtSource | null = null
    try {
      source = refreshCb ? await refreshCb(ref) : null
    } catch {
      source = null
    }
    post({ type: 'refreshed', nonce, source })
  }

  win.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== win.parent || win.parent === (win as unknown) || !origins.includes(e.origin)) return
    const d = e.data as Record<string, unknown> | null
    if (!d || typeof d !== 'object' || d.juntos !== 1) return
    if (parentOrigin && e.origin !== parentOrigin) return
    if (d.type === 'init' && isTheme(d.theme) && typeof d.locale === 'string' && typeof d.canPlay === 'boolean') {
      parentOrigin = e.origin
      init = { juntos: 1, type: 'init', theme: d.theme, locale: d.locale, canPlay: d.canPlay }
      applyTheme(init.theme)
      for (const cb of initCbs) cb(init)
    } else if (d.type === 'theme' && isTheme(d.theme)) {
      parentOrigin = e.origin
      applyTheme(d.theme)
      for (const cb of themeCbs) cb(d.theme)
    } else if (d.type === 'refresh' && typeof d.nonce === 'string' && typeof d.ref === 'string') {
      parentOrigin = e.origin
      void answerRefresh(d.nonce, d.ref)
    }
  })

  return {
    onInit(cb: (i: InitMessage) => void) {
      initCbs.push(cb)
      if (init) cb(init)
    },
    onTheme(cb: (t: ThemeTokens) => void) {
      themeCbs.push(cb)
    },
    onRefresh(cb: (ref: string) => Promise<ExtSource | null>) {
      refreshCb = cb
    },
    ready: () => post({ type: 'ready' }),
    play: (p: PlayRequest) => post({ ...p, type: 'play' }),
    close: () => post({ type: 'close' }),
    toast: (text: string) => post({ type: 'toast', text }),
  }
}

export type Juntos = ReturnType<typeof installJuntos>
