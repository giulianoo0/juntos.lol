export interface ThemeTokens {
  mode: 'dark' | 'light'
  vars: Record<string, string>
}
/** Headers the CDN insists on: `user-agent`, `referer`, `origin`. A source with them, in http or with a port, plays only in the app. */
export type ExtHeaders = Partial<Record<'user-agent' | 'referer' | 'origin', string>>
export type ExtSource =
  | { kind: 'hls' | 'file'; url: string; headers?: ExtHeaders }
  | { kind: 'torrent'; infoHash: string; fileIdx?: number; trackers?: string[] }
  | { kind: 'youtube'; id: string }
export interface ExtSubtitle {
  url: string
  /** ISO 639-2 (`por`, `eng`) or a BCP 47 tag. */
  lang: string
  label?: string
}
export interface InitMessage {
  juntos: 1
  type: 'init'
  theme: ThemeTokens
  locale: string
  canPlay: boolean
  /** The page is the desktop app, which plays what only it reads. */
  app: boolean
  /** The app sends `juntos.fetch` calls itself, with any User-Agent. */
  fetch: boolean
  /** The app keeps `juntos.store` sealed on disk, with the key in the system keychain. */
  store: boolean
}
export interface PlayRequest {
  title: string
  subtitle?: string
  poster?: string
  ref: string
  source: ExtSource
  subtitles?: ExtSubtitle[]
}

type SdkWindow = Pick<Window, 'parent' | 'document' | 'addEventListener' | 'fetch'> & {
  location: { ancestorOrigins?: ArrayLike<string> }
  localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

const CALL_WAIT_MS = 60_000
const STORE_WAIT_MS = 10_000
const INIT_WAIT_MS = 2_000

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
  let readied = false
  let nextCall = 0
  const calls = new Map<string, (answer: { status: number; contentType?: unknown; body: unknown }) => void>()
  const stores = new Map<string, (answer: { ok: boolean; value: unknown }) => void>()

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
      init = { juntos: 1, type: 'init', theme: d.theme, locale: d.locale, canPlay: d.canPlay, app: d.app === true, fetch: d.fetch === true, store: d.store === true }
      applyTheme(init.theme)
      for (const cb of initCbs) cb(init)
    } else if (d.type === 'theme' && isTheme(d.theme)) {
      parentOrigin = e.origin
      applyTheme(d.theme)
      for (const cb of themeCbs) cb(d.theme)
    } else if (d.type === 'refresh' && typeof d.nonce === 'string' && typeof d.ref === 'string') {
      parentOrigin = e.origin
      void answerRefresh(d.nonce, d.ref)
    } else if (d.type === 'fetched' && typeof d.nonce === 'string' && typeof d.status === 'number') {
      calls.get(d.nonce)?.({ status: d.status, contentType: d.contentType, body: d.body })
    } else if (d.type === 'stored' && typeof d.nonce === 'string' && typeof d.ok === 'boolean') {
      stores.get(d.nonce)?.({ ok: d.ok, value: d.value })
    }
  })

  /** The init, if `ready` went out and it is still on its way. */
  function settledInit(): Promise<InitMessage | null> {
    if (init || !readied) return Promise.resolve(init)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(init), INIT_WAIT_MS)
      initCbs.push((i) => { clearTimeout(timer); resolve(i) })
    })
  }

  function viaApp(url: string, method: string, headers: Record<string, string>, body: string | undefined): Promise<Response> {
    const nonce = `c${nextCall++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { calls.delete(nonce); reject(new TypeError('juntos.fetch: no answer')) }, CALL_WAIT_MS)
      calls.set(nonce, (answer) => {
        calls.delete(nonce)
        clearTimeout(timer)
        if (answer.status < 200 || answer.status > 599) {
          reject(new TypeError('juntos.fetch: network error'))
          return
        }
        const type = typeof answer.contentType === 'string' ? { 'content-type': answer.contentType } : undefined
        const nobody = answer.status === 204 || answer.status === 205 || answer.status === 304
        resolve(new Response(nobody ? null : String(answer.body ?? ''), { status: answer.status, headers: type }))
      })
      post({ type: 'fetch', nonce, url, method, headers, ...(body === undefined ? {} : { body }) })
    })
  }

  /**
   * fetch, but in the desktop app the call goes out through the app, which
   * sends the headers a webview drops (User-Agent among them). Only urls on
   * `hosts.connect`, and a body only as text.
   */
  async function juntosFetch(input: string | URL, opts: RequestInit = {}): Promise<Response> {
    const ready = await settledInit()
    if (!ready?.fetch || (opts.body !== undefined && opts.body !== null && typeof opts.body !== 'string')) {
      return win.fetch(input, opts)
    }
    const headers: Record<string, string> = {}
    new Headers(opts.headers).forEach((value, name) => { headers[name.toLowerCase()] = value })
    return viaApp(String(input), (opts.method ?? 'GET').toUpperCase(), headers, opts.body ?? undefined)
  }

  function viaStore(key: string, value?: string | null): Promise<string | null> {
    const nonce = `s${nextCall++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { stores.delete(nonce); reject(new Error('juntos.store: no answer')) }, STORE_WAIT_MS)
      stores.set(nonce, (answer) => {
        stores.delete(nonce)
        clearTimeout(timer)
        if (!answer.ok) reject(new Error('juntos.store: refused'))
        else resolve(typeof answer.value === 'string' ? answer.value : null)
      })
      post({ type: 'store', nonce, key, ...(value === undefined ? {} : { value }) })
    })
  }

  /**
   * Text that survives the app closing. In the desktop app it is sealed on
   * disk with a key in the system keychain, reachable only by this
   * extension; elsewhere it is the frame's localStorage.
   */
  const store = {
    async get(key: string): Promise<string | null> {
      if ((await settledInit())?.store) return viaStore(key)
      try { return win.localStorage?.getItem(key) ?? null } catch { return null }
    },
    async set(key: string, value: string | null): Promise<void> {
      if ((await settledInit())?.store) {
        await viaStore(key, value)
        return
      }
      try {
        if (value === null) win.localStorage?.removeItem(key)
        else win.localStorage?.setItem(key, value)
      } catch {
        // storage blocked: the value lives as long as the page
      }
    },
  }

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
    ready: () => { readied = true; post({ type: 'ready' }) },
    fetch: juntosFetch,
    store,
    play: (p: PlayRequest) => post({ ...p, type: 'play' }),
    close: () => post({ type: 'close' }),
    toast: (text: string) => post({ type: 'toast', text }),
  }
}

export type Juntos = ReturnType<typeof installJuntos>
