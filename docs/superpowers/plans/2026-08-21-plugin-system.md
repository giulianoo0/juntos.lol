# Sistema de plugins de fontes — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tirar o Torrentio de dentro do repositório e pôr no lugar um ponto de extensão: plugins de terceiros, instalados pelo host, que resolvem fontes de mídia por torrent ou por URL direta — e, ao lado dele, o Plex como fonte nativa.

**Architecture:** Um plugin é um módulo ES com `manifest` e `streams`, executado num Web Worker servido com uma CSP própria e de onde todo global de rede foi removido — inclusive pela cadeia de protótipos, e inclusive `Worker`. Nenhum código de plugin roda na página, nem para ler o manifest. A única saída é `api.fetch`, mediado pela página contra os hosts que o manifest declarou, aplicado também à URL onde a resposta chegou. Instalados vivem no IndexedDB do navegador do host, chaveados pela origem de onde vieram. O que o plugin devolve é o formato de stream do Stremio, que o parser existente já entende, acrescido do caso de URL direta — e para esse caso o servidor ganha uma ingestão própria, com guarda de SSRF, modelada na ingestão de torrent que já existe.

O Plex entra pelo outro lado: fonte nativa, fora do sistema de plugins, porque precisa de pareamento, credencial guardada e descoberta de servidor — coisas que não se dá a todo plugin. Os bytes dele vão para a sala pelo servidor quando a conexão vencedora é pública, e pelo navegador do host quando é de rede local, reusando a bomba tus que o caminho de torrent já tem.

**Tech Stack:** React 18, TypeScript, Vite 8, vitest, `fake-indexeddb` (novo), Go 1.x com gin, Astro + Starlight + `toolbeam-docs-theme` (repo separado).

**Spec:** `docs/superpowers/specs/2026-08-21-plugin-system-design.md`

## Global Constraints

- Nada de plugin chega ao servidor. O que chega é uma URL que o plugin produziu, e ela passa pela guarda de SSRF.
- Toda string visível ao usuário entra nos dois arquivos de i18n: `web/src/i18n/pt-BR.ts` e `web/src/i18n/en.ts`. Chave ausente em um dos dois é falha.
- Comentários no código explicam **por que**, não **o que** — é o padrão do repositório. Siga o tom dos arquivos vizinhos.
- `npm run test`, `npm run lint` e `npm run build` rodam de dentro de `web/`. Go: `go test ./...` da raiz.
- Nenhuma tarefa deixa a árvore quebrada: cada uma termina com testes passando e um commit.
- Commits sem `Co-Authored-By` e sem `Claude-Session` — o repositório não os usa nesta linha de trabalho.
- `VITE_STREAM_ADDON` deixa de existir; não reintroduza um endereço de addon embutido em lugar nenhum.

---

### Task 1: Parse e validação do manifest

**Files:**
- Create: `web/src/plugins/manifest.ts`
- Test: `web/src/plugins/manifest.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `PluginManifest` (`{ id: string; name: string; version: string; hosts: string[]; updateUrl: string | null }`), `parseManifest(value: unknown): PluginManifest` (lança `Error` com mensagem estável em caso inválido).

- [ ] **Step 1: Write the failing test**

```ts
// web/src/plugins/manifest.test.ts
import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest'

const valid = { id: 'torrentio', name: 'Torrentio', version: '1.0.0', hosts: ['torrentio.strem.fun'] }

describe('parseManifest', () => {
  it('accepts the minimum valid manifest and defaults updateUrl to null', () => {
    expect(parseManifest(valid)).toEqual({ ...valid, updateUrl: null })
  })

  it('keeps an https updateUrl', () => {
    const parsed = parseManifest({ ...valid, updateUrl: 'https://github.com/user/repo' })
    expect(parsed.updateUrl).toBe('https://github.com/user/repo')
  })

  it('rejects an id outside the allowed shape', () => {
    expect(() => parseManifest({ ...valid, id: 'Torrentio!' })).toThrow(/id/)
    expect(() => parseManifest({ ...valid, id: '' })).toThrow(/id/)
  })

  it('rejects an empty host list', () => {
    expect(() => parseManifest({ ...valid, hosts: [] })).toThrow(/hosts/)
  })

  it('rejects hosts carrying a scheme, a path or a port', () => {
    expect(() => parseManifest({ ...valid, hosts: ['https://a.com'] })).toThrow(/hosts/)
    expect(() => parseManifest({ ...valid, hosts: ['a.com/x'] })).toThrow(/hosts/)
    expect(() => parseManifest({ ...valid, hosts: ['a.com:8080'] })).toThrow(/hosts/)
  })

  it('rejects a non-https updateUrl', () => {
    expect(() => parseManifest({ ...valid, updateUrl: 'http://github.com/u/r' })).toThrow(/updateUrl/)
  })

  it('rejects missing fields and non-objects', () => {
    expect(() => parseManifest({ ...valid, name: undefined })).toThrow(/name/)
    expect(() => parseManifest(null)).toThrow(/manifest/)
    expect(() => parseManifest('nope')).toThrow(/manifest/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plugins/manifest.test.ts`
Expected: FAIL — `Failed to resolve import "./manifest"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/plugins/manifest.ts

/** What a plugin says about itself. Read once at install, then stored. */
export interface PluginManifest {
  id: string
  name: string
  version: string
  /** Hostnames the plugin is allowed to reach. Never empty. */
  hosts: string[]
  /** Where the plugin updates itself from, or null for a file with no home. */
  updateUrl: string | null
}

const ID_PATTERN = /^[a-z0-9-]{1,64}$/
// A bare hostname: labels of letters, digits and hyphens joined by dots. No
// scheme, no port, no path — the policy compares hostnames, and anything
// carrying more than a hostname would compare against something that never
// appears on the other side. At least one dot is required, which rules out
// single-label names — there is no addon on the public internet at `intranet`,
// and allowing it only widens what a declared host can reach.
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

const MAX_NAME = 64
const MAX_VERSION = 32
const MAX_HOSTS = 16
const MAX_HOST_LENGTH = 253

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new Error(`plugin manifest: ${field} is missing or invalid`)
  }
  return value.trim()
}

export function parseManifest(value: unknown): PluginManifest {
  if (typeof value !== 'object' || value === null) throw new Error('plugin manifest: not an object')
  const raw = value as Record<string, unknown>

  const id = text(raw.id, 'id', 64)
  if (!ID_PATTERN.test(id)) throw new Error('plugin manifest: id must match [a-z0-9-]')

  const name = text(raw.name, 'name', MAX_NAME)
  const version = text(raw.version, 'version', MAX_VERSION)

  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0 || raw.hosts.length > MAX_HOSTS) {
    throw new Error('plugin manifest: hosts must be a non-empty list')
  }
  const hosts = raw.hosts.map((host) => {
    // 253 is the longest a hostname can legally be. Without a ceiling here,
    // `hosts` is the one field with no length limit at all.
    if (typeof host !== 'string' || host.length > MAX_HOST_LENGTH || !HOST_PATTERN.test(host.toLowerCase())) {
      throw new Error('plugin manifest: hosts must be bare hostnames')
    }
    return host.toLowerCase()
  })

  let updateUrl: string | null = null
  if (raw.updateUrl !== undefined && raw.updateUrl !== null) {
    const candidate = text(raw.updateUrl, 'updateUrl', 512)
    let parsed: URL
    try {
      parsed = new URL(candidate)
    } catch {
      throw new Error('plugin manifest: updateUrl is not a URL')
    }
    if (parsed.protocol !== 'https:') throw new Error('plugin manifest: updateUrl must be https')
    updateUrl = candidate
  }

  return { id, name, version, hosts, updateUrl }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/plugins/manifest.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/plugins/manifest.ts web/src/plugins/manifest.test.ts
git commit -m "feat: parse and validate a plugin manifest"
```

---

### Task 2: Política de rede do plugin

**Files:**
- Create: `web/src/plugins/policy.ts`
- Test: `web/src/plugins/policy.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `checkFetchUrl(raw: string, hosts: string[], selfOrigin: string): { ok: true; url: URL } | { ok: false; reason: FetchDenial }`, com `type FetchDenial = 'invalid' | 'scheme' | 'self-origin' | 'private-host' | 'host-not-declared'`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/plugins/policy.test.ts
import { describe, expect, it } from 'vitest'
import { checkFetchUrl } from './policy'

const hosts = ['torrentio.strem.fun']
const self = 'https://ss.giuli.dev'

const deny = (url: string) => {
  const result = checkFetchUrl(url, hosts, self)
  if (result.ok) throw new Error(`expected ${url} to be denied`)
  return result.reason
}

describe('checkFetchUrl', () => {
  it('allows a declared host over https', () => {
    const result = checkFetchUrl('https://torrentio.strem.fun/stream/movie/tt1.json', hosts, self)
    expect(result.ok).toBe(true)
  })

  it('matches the host exactly, so a subdomain is not covered', () => {
    expect(deny('https://evil.torrentio.strem.fun/x')).toBe('host-not-declared')
    expect(deny('https://torrentio.strem.fun.evil.com/x')).toBe('host-not-declared')
  })

  it('refuses anything that is not https', () => {
    expect(deny('http://torrentio.strem.fun/x')).toBe('scheme')
    expect(deny('data:text/plain,hi')).toBe('scheme')
    expect(deny('file:///etc/passwd')).toBe('scheme')
  })

  it('refuses the application own origin even if someone declares it', () => {
    expect(checkFetchUrl('https://ss.giuli.dev/api/rooms', ['ss.giuli.dev'], self)).toEqual({
      ok: false, reason: 'self-origin',
    })
  })

  it('refuses loopback and literal addresses', () => {
    expect(deny('https://localhost/x')).toBe('private-host')
    expect(deny('https://127.0.0.1/x')).toBe('private-host')
    expect(deny('https://[::1]/x')).toBe('private-host')
    expect(deny('https://192.168.0.1/x')).toBe('private-host')
  })

  it('refuses a value that is not a URL at all', () => {
    expect(deny('not a url')).toBe('invalid')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plugins/policy.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/plugins/policy.ts

export type FetchDenial = 'invalid' | 'scheme' | 'self-origin' | 'private-host' | 'host-not-declared'

export type FetchDecision =
  | { ok: true; url: URL }
  | { ok: false; reason: FetchDenial }

// A literal address is never a legitimate target for a catalog addon, and it
// is the shape an attempt at the local network takes. Names that resolve to
// private space are not caught here — the browser will not tell us the
// address — which is why the server has its own guard for the URLs a plugin
// hands it.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const PRIVATE_NAMES = new Set(['localhost'])

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (PRIVATE_NAMES.has(host) || host.endsWith('.localhost')) return true
  // URL keeps IPv6 in brackets.
  if (host.startsWith('[')) return true
  if (IPV4.test(host)) return true
  return false
}

/**
 * Decides whether a plugin's request happens. The plugin never performs it —
 * the page does, after this — so this is the whole boundary.
 */
export function checkFetchUrl(raw: string, hosts: string[], selfOrigin: string): FetchDecision {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'scheme' }
  if (url.origin === selfOrigin) return { ok: false, reason: 'self-origin' }
  if (isPrivateHostname(url.hostname)) return { ok: false, reason: 'private-host' }
  if (!hosts.includes(url.hostname.toLowerCase())) return { ok: false, reason: 'host-not-declared' }
  return { ok: true, url }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/plugins/policy.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/plugins/policy.ts web/src/plugins/policy.test.ts
git commit -m "feat: gate plugin network access on declared hosts"
```

---

### Task 3: O runtime — orquestração de uma resolução

O worker de verdade entra na Task 4. Aqui fica a lógica que decide: tetos de tempo e de requisições, mediação de cada `api.fetch`, e o encerramento. Ela recebe o "spawn" por parâmetro, o que a torna testável sem `Worker` — que o jsdom não tem.

**Files:**
- Create: `web/src/plugins/runtime.ts`
- Test: `web/src/plugins/runtime.test.ts`

**Interfaces:**
- Consumes: `checkFetchUrl` da Task 2.
- Produces:
  - `type WorkerRequest = { kind: 'fetch'; id: number; url: string } | { kind: 'done'; streams: unknown } | { kind: 'error'; message: string }`
  - `type WorkerReply = { id: number; ok: boolean; status: number; text: string }`
  - `interface PluginHandle { post(reply: WorkerReply): void; terminate(): void }`
  - `interface SpawnOptions { onMessage(message: WorkerRequest): void }`
  - `type FetchResult = { ok: boolean; status: number; text: string; finalUrl?: string }`
  - `runPlugin(options: RunPluginOptions): Promise<unknown>` onde
    `RunPluginOptions = { hosts: string[]; selfOrigin: string; spawn(options: SpawnOptions): PluginHandle; fetchUrl(url: URL, signal: AbortSignal): Promise<FetchResult>; timeoutMs?: number; maxRequests?: number }`
  - `PluginRunError` com `.reason: 'timeout' | 'too-many-requests' | 'plugin-error'`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/plugins/runtime.test.ts
import { describe, expect, it, vi } from 'vitest'
import { PluginRunError, runPlugin, type SpawnOptions, type WorkerReply, type WorkerRequest } from './runtime'

/** A stand-in worker: the test drives it by calling `emit`. */
function fakeWorker() {
  let onMessage: ((message: WorkerRequest) => void) | null = null
  const replies: WorkerReply[] = []
  const terminated = { value: false }
  const spawn = (options: SpawnOptions) => {
    onMessage = options.onMessage
    return {
      post: (reply: WorkerReply) => replies.push(reply),
      terminate: () => { terminated.value = true },
    }
  }
  return { spawn, replies, terminated, emit: (message: WorkerRequest) => onMessage?.(message) }
}

const base = { hosts: ['a.com'], selfOrigin: 'https://ss.giuli.dev' }

describe('runPlugin', () => {
  it('resolves with whatever the plugin reported', async () => {
    const worker = fakeWorker()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl: vi.fn() })
    worker.emit({ kind: 'done', streams: [{ infoHash: 'abc' }] })
    await expect(promise).resolves.toEqual([{ infoHash: 'abc' }])
    expect(worker.terminated.value).toBe(true)
  })

  it('performs an allowed fetch and hands the body back', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: '{"streams":[]}' })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl })
    worker.emit({ kind: 'fetch', id: 1, url: 'https://a.com/x' })
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1))
    expect(fetchUrl).toHaveBeenCalledOnce()
    expect(worker.replies[0]).toEqual({ id: 1, ok: true, status: 200, text: '{"streams":[]}' })
    worker.emit({ kind: 'done', streams: [] })
    await promise
  })

  it('answers a denied fetch without performing it', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl })
    worker.emit({ kind: 'fetch', id: 7, url: 'https://evil.com/x' })
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1))
    expect(fetchUrl).not.toHaveBeenCalled()
    expect(worker.replies[0]).toMatchObject({ id: 7, ok: false, status: 0 })
    worker.emit({ kind: 'done', streams: [] })
    await promise
  })

  it('kills a plugin that goes over the request ceiling', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: '' })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl, maxRequests: 2 })
    worker.emit({ kind: 'fetch', id: 1, url: 'https://a.com/1' })
    worker.emit({ kind: 'fetch', id: 2, url: 'https://a.com/2' })
    worker.emit({ kind: 'fetch', id: 3, url: 'https://a.com/3' })
    await expect(promise).rejects.toMatchObject({ reason: 'too-many-requests' })
    expect(worker.terminated.value).toBe(true)
  })

  it('kills a plugin that runs past its time budget', async () => {
    vi.useFakeTimers()
    const worker = fakeWorker()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl: vi.fn(), timeoutMs: 1_000 })
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
    expect(worker.terminated.value).toBe(true)
    vi.useRealTimers()
  })

  it('refuses a body that a declared host redirected in from somewhere else', async () => {
    const worker = fakeWorker()
    const fetchUrl = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: 'secret', finalUrl: 'https://evil.com/x',
    })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl })
    worker.emit({ kind: 'fetch', id: 4, url: 'https://a.com/x' })
    await vi.waitFor(() => expect(worker.replies).toHaveLength(1))
    expect(worker.replies[0]).toMatchObject({ id: 4, ok: false, status: 0 })
    expect(worker.replies[0].text).not.toContain('secret')
    worker.emit({ kind: 'done', streams: [] })
    await promise
  })

  it('answers a request that arrived before spawn returned', async () => {
    // A spawn that drives onMessage synchronously used to post into a null
    // handle and lose the reply for ever.
    const replies: WorkerReply[] = []
    let onMessage: ((message: WorkerRequest) => void) | null = null
    const spawn = (options: SpawnOptions) => {
      onMessage = options.onMessage
      onMessage({ kind: 'fetch', id: 1, url: 'https://a.com/x' })
      return { post: (reply: WorkerReply) => replies.push(reply), terminate: () => undefined }
    }
    const promise = runPlugin({ ...base, spawn, fetchUrl: vi.fn().mockResolvedValue({ ok: true, status: 200, text: 'x' }) })
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    onMessage?.({ kind: 'done', streams: [] })
    await expect(promise).resolves.toEqual([])
  })

  it('aborts requests still in flight when the plugin is killed', async () => {
    vi.useFakeTimers()
    const worker = fakeWorker()
    let seen: AbortSignal | null = null
    const fetchUrl = vi.fn((_url: URL, signal: AbortSignal) => {
      seen = signal
      return new Promise<never>(() => undefined)
    })
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl, timeoutMs: 1_000 })
    worker.emit({ kind: 'fetch', id: 1, url: 'https://a.com/x' })
    const assertion = expect(promise).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(1_001)
    await assertion
    expect(seen?.aborted).toBe(true)
    vi.useRealTimers()
  })

  it('surfaces an error the plugin threw', async () => {
    const worker = fakeWorker()
    const promise = runPlugin({ ...base, spawn: worker.spawn, fetchUrl: vi.fn() })
    worker.emit({ kind: 'error', message: 'boom' })
    await expect(promise).rejects.toBeInstanceOf(PluginRunError)
    await expect(promise).rejects.toMatchObject({ reason: 'plugin-error', message: expect.stringContaining('boom') })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plugins/runtime.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/plugins/runtime.ts
import { checkFetchUrl } from './policy'

export type WorkerRequest =
  | { kind: 'fetch'; id: number; url: string }
  | { kind: 'done'; streams: unknown }
  | { kind: 'error'; message: string }

export interface WorkerReply {
  id: number
  ok: boolean
  status: number
  text: string
}

export interface PluginHandle {
  post(reply: WorkerReply): void
  terminate(): void
}

export interface SpawnOptions {
  onMessage(message: WorkerRequest): void
}

/**
 * What the page reports back about a request it performed.
 *
 * `finalUrl` is where the response actually came from. It matters because a
 * declared host is free to answer 302 and send the page somewhere else, and a
 * policy that only inspects the request is a pre-flight policy.
 */
export interface FetchResult {
  ok: boolean
  status: number
  text: string
  finalUrl?: string
}

export interface RunPluginOptions {
  hosts: string[]
  selfOrigin: string
  spawn(options: SpawnOptions): PluginHandle
  fetchUrl(url: URL, signal: AbortSignal): Promise<FetchResult>
  timeoutMs?: number
  maxRequests?: number
}

export type RunFailure = 'timeout' | 'too-many-requests' | 'plugin-error'

export class PluginRunError extends Error {
  readonly reason: RunFailure
  constructor(reason: RunFailure, message: string) {
    super(message)
    this.name = 'PluginRunError'
    this.reason = reason
  }
}

/** A resolution that has not finished in this long is not going to. */
const DEFAULT_TIMEOUT_MS = 15_000
/** Enough for a paginated addon, far short of using the page as a crawler. */
const DEFAULT_MAX_REQUESTS = 32

export function runPlugin(options: RunPluginOptions): Promise<unknown> {
  const { hosts, selfOrigin, spawn, fetchUrl } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS

  return new Promise<unknown>((resolve, reject) => {
    let settled = false
    let requests = 0
    let handle: PluginHandle | null = null
    // Requests answered before `spawn` returns would be posted into a null
    // handle and lost in silence. They wait here instead.
    const outbox: WorkerReply[] = []
    // Everything the page has in flight for this plugin, cancelled together
    // with the worker. Without it the time ceiling kills the worker and the
    // requests it started keep running.
    const inflight = new AbortController()

    const post = (reply: WorkerReply) => {
      if (handle) handle.post(reply)
      else outbox.push(reply)
    }

    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      inflight.abort()
      handle?.terminate()
      run()
    }

    const timer = window.setTimeout(() => {
      finish(() => reject(new PluginRunError('timeout', `plugin exceeded ${timeoutMs}ms`)))
    }, timeoutMs)

    const onMessage = (message: WorkerRequest) => {
      if (settled) return
      if (message.kind === 'done') {
        finish(() => resolve(message.streams))
        return
      }
      if (message.kind === 'error') {
        finish(() => reject(new PluginRunError('plugin-error', `plugin failed: ${message.message}`)))
        return
      }
      requests += 1
      if (requests > maxRequests) {
        finish(() => reject(new PluginRunError('too-many-requests', `plugin exceeded ${maxRequests} requests`)))
        return
      }
      const decision = checkFetchUrl(message.url, hosts, selfOrigin)
      if (!decision.ok) {
        // A refusal is answered rather than thrown: a plugin that asks for
        // something it may not have should get to handle that, the same as it
        // would handle a server saying no.
        post({ id: message.id, ok: false, status: 0, text: `blocked: ${decision.reason}` })
        return
      }
      fetchUrl(decision.url, inflight.signal)
        .then(({ finalUrl, ...response }) => {
          if (settled) return
          // The allowlist applies to where the response came from, not only to
          // where the request went.
          const landed = finalUrl ? checkFetchUrl(finalUrl, hosts, selfOrigin) : null
          if (landed && !landed.ok) {
            post({ id: message.id, ok: false, status: 0, text: `blocked: redirect-${landed.reason}` })
            return
          }
          post({ id: message.id, ...response })
        })
        .catch((error: unknown) => {
          if (!settled) post({ id: message.id, ok: false, status: 0, text: String(error) })
        })
    }

    handle = spawn({ onMessage })
    // `spawn` may have called `onMessage` synchronously, in which case the
    // run is already over or there are replies waiting.
    if (settled) handle.terminate()
    else for (const reply of outbox.splice(0)) handle.post(reply)
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/plugins/runtime.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/plugins/runtime.ts web/src/plugins/runtime.test.ts
git commit -m "feat: run a plugin under a time and request budget"
```

---

### Task 4: O worker endurecido e o `spawn` real

Este é o único pedaço sem teste automático: jsdom não tem `Worker`, e um ambiente de browser não está montado neste repositório. Ele é mantido fino de propósito — toda a decisão vive na Task 3 — e é verificado à mão no passo 6.

É também o pedaço onde um erro custa mais caro, então leia o comentário de cabeçalho do worker antes de mexer em qualquer linha dele.

**Files:**
- Create: `web/src/plugins/worker.ts`
- Create: `web/src/plugins/spawn.ts`
- Modify: `web/vite.config.ts`

**Interfaces:**
- Consumes: `PluginHandle`, `SpawnOptions`, `WorkerReply`, `WorkerRequest`, `FetchResult` da Task 3.
- Produces:
  - `spawnPluginWorker(source: string, target: unknown): (options: SpawnOptions) => PluginHandle`
  - `spawnManifestReader(source: string): (options: SpawnOptions) => PluginHandle`
  - `pageFetch(url: URL, signal: AbortSignal): Promise<FetchResult>`

- [ ] **Step 1: Let Vite build the worker as a module**

Em `web/vite.config.ts`, acrescente ao objeto de configuração:

```ts
  // The plugin worker dynamically imports the plugin's own module, and a
  // classic worker cannot do that. Vite's build default is 'iife', which
  // means this works in `npm run dev` and breaks after deploy — the worst
  // shape a bug can have.
  worker: { format: 'es' },
```

- [ ] **Step 2: Write the worker bootstrap**

```ts
// web/src/plugins/worker.ts
/// <reference lib="webworker" />

/**
 * The bootstrap a plugin wakes up inside.
 *
 * Three layers, and no single one of them is enough.
 *
 * 1. The header. This script is served with
 *    `Content-Security-Policy: default-src 'none'; connect-src 'none'`
 *    (Task 16). It is the only layer plugin code cannot reach around by
 *    construction, and the only thing that stops a dynamic `import()` of a
 *    remote module — which, from in here, nothing can remove.
 *
 * 2. The scope, below. Note that it deletes along the prototype chain rather
 *    than assigning `undefined` to `self`. `fetch` and friends live on
 *    `WorkerGlobalScope.prototype`, so an own-property assignment only
 *    shadows them, and `Object.getPrototypeOf(self).fetch` walks straight
 *    past it. `Worker` is on the list for the same class of reason: a nested
 *    worker is born with an untouched scope, and it would make everything
 *    above pointless.
 *
 * 3. The page. `api.fetch` is a message, and the page decides — including
 *    where a redirect landed. See runtime.ts.
 *
 * What is deliberately NOT claimed: that a plugin cannot compute whatever it
 * likes, or that it cannot return a magnet the room will open. Trust ends
 * with whoever wrote the plugin. What is enforced is that it never reaches
 * this site's own origin, its API, or its storage.
 */

const BLOCKED = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'WebTransport',
  'caches', 'indexedDB', 'importScripts', 'BroadcastChannel', 'Notification',
  'Worker', 'SharedWorker', 'RTCPeerConnection',
]

for (const name of BLOCKED) {
  // Delete wherever it actually lives, not only where it appears to.
  for (let object: object | null = self; object; object = Object.getPrototypeOf(object) as object | null) {
    if (!Object.prototype.hasOwnProperty.call(object, name)) continue
    try {
      delete (object as Record<string, unknown>)[name]
    } catch {
      // Non-configurable: the defineProperty below is the second attempt.
    }
  }
  try {
    Object.defineProperty(self, name, { value: undefined, writable: false, configurable: false })
  } catch {
    // Nothing more to do from in here. The CSP header is what this rests on.
  }
}
try {
  delete (navigator as unknown as Record<string, unknown>).sendBeacon
} catch { /* see above */ }

interface Reply {
  ok: boolean
  status: number
  text: string
}

const pending = new Map<number, (reply: Reply) => void>()
let nextId = 0

const api = {
  fetch(url: string) {
    const id = (nextId += 1)
    return new Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }>(
      (resolve) => {
        pending.set(id, (reply) => resolve({
          ok: reply.ok,
          status: reply.status,
          text: () => Promise.resolve(reply.text),
          json: () => Promise.resolve(JSON.parse(reply.text) as unknown),
        }))
        self.postMessage({ kind: 'fetch', id, url })
      },
    )
  },
}

self.onmessage = (event: MessageEvent) => {
  const data = event.data as Record<string, unknown>
  if (data.kind === 'reply') {
    const resolve = pending.get(data.id as number)
    if (!resolve) return
    pending.delete(data.id as number)
    resolve(data as unknown as Reply)
    return
  }
  if (data.kind !== 'start') return
  void (async () => {
    try {
      const module = await import(/* @vite-ignore */ data.pluginUrl as string) as {
        manifest?: unknown
        streams?: (target: unknown, api: unknown) => Promise<unknown>
      }
      // Importing already ran the plugin's top level. That it happened in
      // here and not in the page is the whole point of reading the manifest
      // through this path.
      if (data.op === 'manifest') {
        self.postMessage({ kind: 'done', streams: module.manifest })
        return
      }
      if (typeof module.streams !== 'function') throw new Error('plugin has no streams export')
      self.postMessage({ kind: 'done', streams: await module.streams(data.target, api) })
    } catch (error) {
      self.postMessage({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  })()
}
```

- [ ] **Step 3: Write the page-side spawn**

```ts
// web/src/plugins/spawn.ts
import type { FetchResult, PluginHandle, SpawnOptions, WorkerRequest } from './runtime'

/** How much of a response body is worth reading. Generous for addon JSON. */
const MAX_BODY_BYTES = 4 << 20

function start(source: string, message: Record<string, unknown>) {
  return (options: SpawnOptions): PluginHandle => {
    const pluginUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent) => options.onMessage(event.data as WorkerRequest)
    worker.postMessage({ kind: 'start', pluginUrl, ...message })
    return {
      post: (reply) => worker.postMessage({ kind: 'reply', ...reply }),
      terminate: () => {
        worker.terminate()
        URL.revokeObjectURL(pluginUrl)
      },
    }
  }
}

/** A worker running this plugin's source, told which title to resolve. */
export function spawnPluginWorker(source: string, target: unknown) {
  return start(source, { op: 'streams', target })
}

/**
 * A worker that imports the plugin and reports its manifest.
 *
 * Reading a manifest means running the module's top level, and running it in
 * the page would hand the plugin localStorage, the plugin registry itself and
 * a same-origin `/api`. Installing and updating both come through here.
 */
export function spawnManifestReader(source: string) {
  return start(source, { op: 'manifest' })
}

/**
 * The page performing what a plugin asked for. Only reached after the policy
 * said yes; `no-store` and `omit` keep this out of the cache and stop any
 * cookie of ours from riding along.
 *
 * `finalUrl` travels back so the runtime can apply the allowlist to where the
 * response came from — following the redirect and then checking is the only
 * order available to a browser, which will not tell us the hops.
 */
export async function pageFetch(url: URL, signal: AbortSignal): Promise<FetchResult> {
  const response = await fetch(url.toString(), {
    credentials: 'omit', cache: 'no-store', redirect: 'follow', signal,
  })
  return {
    ok: response.ok,
    status: response.status,
    text: await readCapped(response, signal),
    finalUrl: response.url || url.toString(),
  }
}

/**
 * Reads at most MAX_BODY_BYTES. `await response.text()` has no ceiling, and
 * 32 requests times an unbounded body is the host's tab downloading gigabytes
 * on a plugin's say-so.
 */
async function readCapped(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  let seen = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || signal.aborted) break
      seen += value.byteLength
      if (seen > MAX_BODY_BYTES) {
        out += decoder.decode(value.slice(0, value.byteLength - (seen - MAX_BODY_BYTES)))
        break
      }
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
  return out
}
```

- [ ] **Step 4: Type-check and lint**

Run: `cd web && npx tsc -b && npx oxlint src`
Expected: sem erros.

- [ ] **Step 5: Verify the sandbox by hand**

Rode `cd web && npm run dev`, abra o console em `http://localhost:5173` e cole:

```js
const { runPlugin } = await import('/src/plugins/runtime.ts')
const { spawnPluginWorker, pageFetch } = await import('/src/plugins/spawn.ts')
const run = (src, hosts = ['httpbin.org']) => runPlugin({
  hosts, selfOrigin: location.origin,
  spawn: spawnPluginWorker(src, { type: 'movie', id: 'tt0111161' }), fetchUrl: pageFetch,
})

// 1. O caminho feliz.
await run(`export const manifest = { id:'t', name:'T', version:'1', hosts:['httpbin.org'] }
export async function streams(target, api) {
  const r = await api.fetch('https://httpbin.org/json')
  return [{ infoHash: '0'.repeat(40), title: target.id + ':' + r.status, name: 'demo' }]
}`)
// Esperado: um array cujo title termina em ":200".

// 2. Host não declarado.
await run(`export const manifest = {}
export async function streams(_t, api) { return [(await api.fetch('https://httpbin.org/json')).status] }`, ['outra.com'])
// Esperado: [0] — a política recusou sem buscar.

// 3. A fuga pelo protótipo. ESTE É O TESTE QUE IMPORTA.
await run(`export const manifest = {}
export async function streams() {
  const f = Object.getPrototypeOf(self).fetch ?? self.constructor?.prototype?.fetch
  return [typeof f]
}`)
// Esperado: ["undefined"]. Se vier ["function"], o worker não está fechado.

// 4. O worker aninhado.
await run(`export const manifest = {}
export async function streams() { return [typeof Worker] }`)
// Esperado: ["undefined"].
```

Confirme os quatro. O terceiro e o quarto são a razão de esta task existir na forma em que está.

- [ ] **Step 6: Verify the production build too**

Run: `cd web && npm run build && npm run preview`

Repita o caso 1 do passo anterior contra a porta do `preview`. O `dev` usa módulos nativos e o build não; um worker que só funciona em `dev` é um bug que só aparece depois do deploy.

- [ ] **Step 7: Commit**

```bash
git add web/src/plugins/worker.ts web/src/plugins/spawn.ts web/vite.config.ts
git commit -m "feat: run plugins in a worker with no path to the network"
```

---

### Task 5: Armazenamento dos instalados

**Files:**
- Create: `web/src/plugins/store.ts`
- Test: `web/src/plugins/store.test.ts`
- Modify: `web/package.json` (devDependency `fake-indexeddb`)
- Modify: `web/src/test/setup.ts`

**Interfaces:**
- Consumes: `PluginManifest` da Task 1.
- Produces:
  - `interface InstalledPlugin { id: string; manifest: PluginManifest; source: string; sha256: string; origin: PluginOrigin; approvedHosts: string[]; enabled: boolean; pendingUpdate: PendingUpdate | null; installedAt: number }`
  - `type PluginOrigin = { kind: 'file'; fileName: string; updateUrl: string | null } | { kind: 'git'; updateUrl: string; commit: string }`
  - `interface PendingUpdate { source: string; sha256: string; manifest: PluginManifest; commit: string; newHosts: string[] }`
  - `listPlugins(): Promise<InstalledPlugin[]>`, `putPlugin(plugin: InstalledPlugin): Promise<void>`, `getPlugin(id: string): Promise<InstalledPlugin | null>`, `deletePlugin(id: string): Promise<void>`, `sha256Hex(source: string): Promise<string>`
  - `originKey(origin: PluginOrigin): string` e `originId(origin: PluginOrigin): Promise<string>` — a chave do registro, derivada da origem

O campo `id` de `InstalledPlugin` **não é** `manifest.id`. É o SHA-256 da origem. Se fosse o do manifest, instalar um repositório qualquer que declarasse `id: 'torrentio'` sobrescreveria o Torrentio instalado — origem, hosts aprovados e código — sem dizer nada. `manifest.id` é rótulo; a origem é identidade.

- [ ] **Step 1: Install the test double for IndexedDB**

```bash
cd web && npm install --save-dev fake-indexeddb
```

Depois acrescente ao topo de `web/src/test/setup.ts`:

```ts
// jsdom has no IndexedDB, and the plugin registry lives in one.
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'

// jsdom ships Crypto without SubtleCrypto, and the registry identifies a
// plugin's version by SHA-256. Without this, five tests across three files
// fail on `crypto.subtle` being undefined.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
}
```

Confirme que faltava mesmo, antes de acreditar: `node -e "const {JSDOM}=require('jsdom');const w=new JSDOM('').window;console.log(!!w.crypto, !!w.crypto?.subtle)"` imprime `true false`.

- [ ] **Step 2: Write the failing test**

```ts
// web/src/plugins/store.test.ts
import { beforeEach, describe, expect, it } from 'vitest'
import { deletePlugin, getPlugin, listPlugins, originId, originKey, putPlugin, sha256Hex, type InstalledPlugin } from './store'

const sample = (id: string, enabled = true): InstalledPlugin => ({
  id,
  manifest: { id, name: id, version: '1.0.0', hosts: ['a.com'], updateUrl: null },
  source: `export const manifest = {}; // ${id}`,
  sha256: 'deadbeef',
  origin: { kind: 'file', fileName: `${id}.js`, updateUrl: null },
  approvedHosts: ['a.com'],
  enabled,
  pendingUpdate: null,
  installedAt: 1,
})

describe('the plugin registry', () => {
  beforeEach(async () => {
    for (const plugin of await listPlugins()) await deletePlugin(plugin.id)
  })

  it('starts empty', async () => {
    expect(await listPlugins()).toEqual([])
  })

  it('stores and reads a plugin back whole', async () => {
    await putPlugin(sample('torrentio'))
    expect(await getPlugin('torrentio')).toEqual(sample('torrentio'))
  })

  it('replaces a plugin when the same record is put again', async () => {
    await putPlugin(sample('torrentio'))
    await putPlugin(sample('torrentio', false))
    expect(await listPlugins()).toHaveLength(1)
    expect((await getPlugin('torrentio'))?.enabled).toBe(false)
  })

  it('keeps two origins apart even when they claim the same manifest id', async () => {
    // The whole reason the record is keyed by origin: a repo that declares
    // `id: 'torrentio'` must not land on top of the installed Torrentio.
    const mine = { kind: 'git' as const, updateUrl: 'https://github.com/me/ss-plugin-torrentio', commit: 'a' }
    const theirs = { kind: 'git' as const, updateUrl: 'https://github.com/someone/evil', commit: 'b' }
    expect(originKey(mine)).not.toBe(originKey(theirs))
    await putPlugin({ ...sample('x'), id: await originId(mine), origin: mine })
    await putPlugin({ ...sample('x'), id: await originId(theirs), origin: theirs })
    expect(await listPlugins()).toHaveLength(2)
  })

  it('removes a plugin', async () => {
    await putPlugin(sample('a'))
    await deletePlugin('a')
    expect(await getPlugin('a')).toBeNull()
  })

  it('answers null for a plugin that was never installed', async () => {
    expect(await getPlugin('ghost')).toBeNull()
  })
})

describe('sha256Hex', () => {
  it('hashes to a stable lowercase hex digest', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/plugins/store.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 4: Write minimal implementation**

```ts
// web/src/plugins/store.ts
import type { PluginManifest } from './manifest'

/** Where a plugin came from, and whether it has a home to update from. */
export type PluginOrigin =
  | { kind: 'file'; fileName: string; updateUrl: string | null }
  | { kind: 'git'; updateUrl: string; commit: string }

/**
 * A newer version held back because it wants hosts the install never
 * approved. It sits here until the person says yes.
 */
export interface PendingUpdate {
  source: string
  sha256: string
  manifest: PluginManifest
  commit: string
  newHosts: string[]
}

export interface InstalledPlugin {
  id: string
  manifest: PluginManifest
  source: string
  sha256: string
  origin: PluginOrigin
  /** Hosts agreed to at install. The policy uses these, not the manifest's. */
  approvedHosts: string[]
  enabled: boolean
  pendingUpdate: PendingUpdate | null
  installedAt: number
}

const DB_NAME = 'ss-plugins'
const DB_VERSION = 1
const STORE = 'plugins'

let connection: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('plugin registry failed to open'))
  })
  return connection
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then((db) => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    const request = work(transaction.objectStore(STORE))
    let result: T
    request.onsuccess = () => { result = request.result }
    // Resolving on the request rather than the transaction would call a write
    // successful before it committed.
    transaction.oncomplete = () => resolve(result)
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? request.error ?? new Error('plugin registry request failed'))
  }))
}

/**
 * A plugin's identity: where it came from, never what it calls itself.
 *
 * Locked at install and never rewritten, which is what makes an update
 * unable to redirect its own update channel — the `known_hosts` argument.
 */
export function originKey(origin: PluginOrigin): string {
  return origin.kind === 'git' ? `git:${origin.updateUrl}` : `file:${origin.fileName}`
}

export function originId(origin: PluginOrigin): Promise<string> {
  return sha256Hex(originKey(origin))
}

export function listPlugins(): Promise<InstalledPlugin[]> {
  return run<InstalledPlugin[]>('readonly', (store) => store.getAll() as IDBRequest<InstalledPlugin[]>)
}

export function getPlugin(id: string): Promise<InstalledPlugin | null> {
  return run<InstalledPlugin | undefined>('readonly', (store) => store.get(id) as IDBRequest<InstalledPlugin | undefined>)
    .then((value) => value ?? null)
}

export function putPlugin(plugin: InstalledPlugin): Promise<void> {
  return run('readwrite', (store) => store.put(plugin) as IDBRequest<IDBValidKey>).then(() => undefined)
}

export function deletePlugin(id: string): Promise<void> {
  return run('readwrite', (store) => store.delete(id) as IDBRequest<undefined>).then(() => undefined)
}

/** Identifies a version of a plugin's code, for display and for comparison. */
export async function sha256Hex(source: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run src/plugins/store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/package-lock.json web/src/test/setup.ts web/src/plugins/store.ts web/src/plugins/store.test.ts
git commit -m "feat: keep installed plugins in an indexeddb registry"
```

---

### Task 6: Instalação por arquivo e por repositório

**Files:**
- Create: `web/src/plugins/install.ts`
- Test: `web/src/plugins/install.test.ts`

**Interfaces:**
- Consumes: `parseManifest` (Task 1), `runPlugin`/`PluginRunError` (Task 3), `spawnManifestReader` (Task 4), `sha256Hex`/`originId`/`InstalledPlugin`/`PluginOrigin` (Task 5).
- Produces:
  - `readManifestFromSource(source: string): Promise<PluginManifest>` — lê o `manifest` **executando o módulo no worker endurecido**, nunca na página.
  - `gitSourceUrls(repoUrl: string): { rawUrl: string; commitApi: string }`
  - `fetchGitPlugin(repoUrl: string, deps?: InstallDeps): Promise<{ source: string; commit: string }>`
  - `buildInstall(source: string, origin: PluginOrigin, deps?: InstallDeps): Promise<InstalledPlugin>`
  - `interface InstallDeps { fetch?: typeof globalThis.fetch; readManifest?: (source: string) => Promise<PluginManifest> }`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/plugins/install.test.ts
import { describe, expect, it, vi } from 'vitest'
import { buildInstall, fetchGitPlugin, gitSourceUrls } from './install'

const manifest = { id: 'torrentio', name: 'Torrentio', version: '1.0.0', hosts: ['torrentio.strem.fun'], updateUrl: null }
const readManifest = () => Promise.resolve(manifest)

describe('gitSourceUrls', () => {
  it('turns a github repo url into a raw file url and a commit endpoint', () => {
    expect(gitSourceUrls('https://github.com/user/repo')).toEqual({
      rawUrl: 'https://raw.githubusercontent.com/user/repo/HEAD/plugin.js',
      commitApi: 'https://api.github.com/repos/user/repo/commits/HEAD',
    })
  })

  it('tolerates a trailing slash and a .git suffix', () => {
    expect(gitSourceUrls('https://github.com/user/repo.git/').rawUrl)
      .toBe('https://raw.githubusercontent.com/user/repo/HEAD/plugin.js')
  })

  it('refuses anything that is not a github repository url', () => {
    expect(() => gitSourceUrls('https://example.com/user/repo')).toThrow(/github/)
    expect(() => gitSourceUrls('https://github.com/user')).toThrow(/repository/)
    expect(() => gitSourceUrls('http://github.com/user/repo')).toThrow(/https/)
  })
})

describe('fetchGitPlugin', () => {
  it('reads the source and the commit sha', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.github.com')) return new Response(JSON.stringify({ sha: 'abc123' }), { status: 200 })
      return new Response('export const manifest = {}', { status: 200 })
    })
    await expect(fetchGitPlugin('https://github.com/user/repo', { fetch: fetchMock as unknown as typeof fetch }))
      .resolves.toEqual({ source: 'export const manifest = {}', commit: 'abc123' })
  })

  it('fails when the repository has no plugin.js', async () => {
    const fetchMock = vi.fn(async () => new Response('Not Found', { status: 404 }))
    await expect(fetchGitPlugin('https://github.com/user/repo', { fetch: fetchMock as unknown as typeof fetch }))
      .rejects.toThrow(/plugin\.js/)
  })
})

describe('buildInstall', () => {
  it('locks the approved hosts to what the manifest asked for at install', async () => {
    const plugin = await buildInstall('src', { kind: 'file', fileName: 'p.js', updateUrl: null }, { readManifest })
    expect(plugin.approvedHosts).toEqual(['torrentio.strem.fun'])
    expect(plugin.enabled).toBe(true)
    expect(plugin.pendingUpdate).toBeNull()
    expect(plugin.sha256).toHaveLength(64)
  })

  it('keys the record by origin, not by the id the manifest claims', async () => {
    const asFile = await buildInstall('src', { kind: 'file', fileName: 'p.js', updateUrl: null }, { readManifest })
    const asRepo = await buildInstall('src', { kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'c' }, { readManifest })
    expect(asFile.id).not.toBe(asRepo.id)
    expect(asFile.id).not.toBe(manifest.id)
    expect(asFile.manifest.id).toBe('torrentio')
  })

  it('carries a file manifest updateUrl into the origin, so a dropped file can still update', async () => {
    const withHome = { ...manifest, updateUrl: 'https://github.com/user/repo' }
    const plugin = await buildInstall('src', { kind: 'file', fileName: 'p.js', updateUrl: null }, {
      readManifest: () => Promise.resolve(withHome),
    })
    expect(plugin.origin).toEqual({ kind: 'file', fileName: 'p.js', updateUrl: 'https://github.com/user/repo' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plugins/install.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/plugins/install.ts
import { parseManifest, type PluginManifest } from './manifest'
import { runPlugin } from './runtime'
import { pageFetch, spawnManifestReader } from './spawn'
import { originId, sha256Hex, type InstalledPlugin, type PluginOrigin } from './store'

export interface InstallDeps {
  fetch?: typeof globalThis.fetch
  readManifest?: (source: string) => Promise<PluginManifest>
}

/** The file a plugin repository is expected to publish. */
const PLUGIN_FILE = 'plugin.js'

/**
 * Reads what a module says about itself.
 *
 * Reading a manifest means running the module's top level, and that happens
 * in the worker, never here. Doing it in the page would hand the plugin
 * `localStorage`, the registry of every other installed plugin, and a
 * same-origin `/api` — and since updates run unattended on every page load
 * over code freshly pulled from a repository, a compromised plugin repo would
 * get all of that without a single click.
 *
 * `hosts: []` is not an oversight. Reading a manifest needs no network at
 * all, so every `api.fetch` this module attempts is refused.
 */
export async function readManifestFromSource(source: string): Promise<PluginManifest> {
  const raw = await runPlugin({
    hosts: [],
    selfOrigin: globalThis.location?.origin ?? '',
    spawn: spawnManifestReader(source),
    fetchUrl: pageFetch,
    timeoutMs: MANIFEST_TIMEOUT_MS,
  })
  return parseManifest(raw)
}

/** Importing a module and reading one object is not a 15-second job. */
const MANIFEST_TIMEOUT_MS = 5_000

export function gitSourceUrls(repoUrl: string): { rawUrl: string; commitApi: string } {
  let url: URL
  try {
    url = new URL(repoUrl)
  } catch {
    throw new Error('plugin source: not a URL')
  }
  if (url.protocol !== 'https:') throw new Error('plugin source: must be https')
  if (url.hostname !== 'github.com') throw new Error('plugin source: only github repositories are supported')
  const parts = url.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean)
  if (parts.length < 2) throw new Error('plugin source: not a repository path')
  const [owner, repo] = parts
  return {
    // HEAD rather than a branch name: a repository that renamed its default
    // branch keeps working, and a plugin installed today keeps updating.
    rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${PLUGIN_FILE}`,
    commitApi: `https://api.github.com/repos/${owner}/${repo}/commits/HEAD`,
  }
}

export async function fetchGitPlugin(repoUrl: string, deps: InstallDeps = {}): Promise<{ source: string; commit: string }> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const { rawUrl, commitApi } = gitSourceUrls(repoUrl)

  const sourceResponse = await request(rawUrl, { credentials: 'omit', cache: 'no-store' })
  if (!sourceResponse.ok) throw new Error(`plugin source: repository has no ${PLUGIN_FILE} (${sourceResponse.status})`)
  const source = await sourceResponse.text()

  // The commit is what an update compares against. A repository that will not
  // report one is still installable; it simply never reports an update.
  let commit = ''
  try {
    const commitResponse = await request(commitApi, { credentials: 'omit', cache: 'no-store' })
    if (commitResponse.ok) {
      const body = await commitResponse.json() as { sha?: unknown }
      if (typeof body.sha === 'string') commit = body.sha
    }
  } catch {
    // Rate limited or offline: the source is in hand, which is what matters.
  }
  return { source, commit }
}

export async function buildInstall(source: string, origin: PluginOrigin, deps: InstallDeps = {}): Promise<InstalledPlugin> {
  const read = deps.readManifest ?? readManifestFromSource
  const manifest = await read(source)
  // A file that declares where it updates from keeps that address, so a
  // dropped plugin is not stranded on the version that happened to be dropped.
  const resolved: PluginOrigin = origin.kind === 'file'
    ? { ...origin, updateUrl: origin.updateUrl ?? manifest.updateUrl }
    : origin
  return {
    // Keyed by origin, not by what the manifest calls itself.
    id: await originId(resolved),
    manifest,
    source,
    sha256: await sha256Hex(source),
    origin: resolved,
    approvedHosts: [...manifest.hosts],
    enabled: true,
    pendingUpdate: null,
    installedAt: Date.now(),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/plugins/install.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/plugins/install.ts web/src/plugins/install.test.ts
git commit -m "feat: install a plugin from a file or a github repository"
```

---

### Task 7: Atualização com origem travada e reconsentimento

**Files:**
- Create: `web/src/plugins/update.ts`
- Test: `web/src/plugins/update.test.ts`

**Interfaces:**
- Consumes: `fetchGitPlugin`/`InstallDeps` (Task 6), `sha256Hex`/`putPlugin`/`listPlugins`/`InstalledPlugin` (Task 5), `parseManifest` (Task 1).
- Produces:
  - `updateUrlOf(plugin: InstalledPlugin): string | null`
  - `type UpdateOutcome = { kind: 'unchanged' } | { kind: 'applied'; version: string } | { kind: 'held'; newHosts: string[] } | { kind: 'refused'; reason: 'origin-changed' } | { kind: 'failed' }`
  - `updatePlugin(plugin: InstalledPlugin, deps?: UpdateDeps): Promise<UpdateOutcome>`
  - `approvePendingUpdate(plugin: InstalledPlugin): Promise<InstalledPlugin>`
  - `updateAll(deps?: UpdateDeps): Promise<Record<string, UpdateOutcome>>`
  - `interface UpdateDeps extends InstallDeps { save?: (plugin: InstalledPlugin) => Promise<void> }`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/plugins/update.test.ts
import { describe, expect, it, vi } from 'vitest'
import { approvePendingUpdate, updatePlugin, updateUrlOf } from './update'
import type { InstalledPlugin } from './store'

const installed: InstalledPlugin = {
  id: 'torrentio',
  manifest: { id: 'torrentio', name: 'Torrentio', version: '1.0.0', hosts: ['a.com'], updateUrl: 'https://github.com/u/r' },
  source: 'old',
  sha256: 'old-hash',
  origin: { kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'aaa' },
  approvedHosts: ['a.com'],
  enabled: true,
  pendingUpdate: null,
  installedAt: 1,
}

const manifestOf = (over: Partial<InstalledPlugin['manifest']>) => ({ ...installed.manifest, ...over })

function deps(over: {
  source?: string; commit?: string; manifest?: InstalledPlugin['manifest']
}, saved: InstalledPlugin[] = []) {
  return {
    fetchGit: vi.fn().mockResolvedValue({ source: over.source ?? 'new', commit: over.commit ?? 'bbb' }),
    readManifest: () => Promise.resolve(over.manifest ?? manifestOf({ version: '1.1.0' })),
    save: async (plugin: InstalledPlugin) => { saved.push(plugin) },
  }
}

describe('updateUrlOf', () => {
  it('reads the address from a git origin', () => {
    expect(updateUrlOf(installed)).toBe('https://github.com/u/r')
  })

  it('reads the address a dropped file declared', () => {
    const file = { ...installed, origin: { kind: 'file' as const, fileName: 'p.js', updateUrl: 'https://github.com/u/r' } }
    expect(updateUrlOf(file)).toBe('https://github.com/u/r')
  })

  it('is null for a file with no home', () => {
    expect(updateUrlOf({ ...installed, origin: { kind: 'file', fileName: 'p.js', updateUrl: null } })).toBeNull()
  })
})

describe('updatePlugin', () => {
  it('does nothing when the commit has not moved', async () => {
    const saved: InstalledPlugin[] = []
    const d = deps({ commit: 'aaa' }, saved)
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'unchanged' })
    expect(saved).toHaveLength(0)
  })

  it('applies a new version whose hosts stayed within what was approved', async () => {
    const saved: InstalledPlugin[] = []
    await expect(updatePlugin(installed, deps({}, saved))).resolves.toEqual({ kind: 'applied', version: '1.1.0' })
    expect(saved[0].source).toBe('new')
    expect(saved[0].manifest.version).toBe('1.1.0')
    expect(saved[0].origin).toEqual({ kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'bbb' })
  })

  it('holds an update that wants a host nobody approved', async () => {
    const saved: InstalledPlugin[] = []
    const d = deps({ manifest: manifestOf({ hosts: ['a.com', 'tracker.evil.com'] }) }, saved)
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'held', newHosts: ['tracker.evil.com'] })
    expect(saved[0].source).toBe('old')
    expect(saved[0].pendingUpdate?.newHosts).toEqual(['tracker.evil.com'])
    expect(saved[0].approvedHosts).toEqual(['a.com'])
  })

  it('does not hold an update that dropped a host', async () => {
    const d = deps({ manifest: manifestOf({ hosts: [] as unknown as string[], version: '2.0.0' }) })
    d.readManifest = () => Promise.resolve(manifestOf({ hosts: ['a.com'], version: '2.0.0' }))
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'applied', version: '2.0.0' })
  })

  it('refuses an update that redirects its own update address', async () => {
    const d = deps({ manifest: manifestOf({ updateUrl: 'https://github.com/someone/else' }) })
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'refused', reason: 'origin-changed' })
  })

  it('reports failure without touching the installed version', async () => {
    const saved: InstalledPlugin[] = []
    const d = { ...deps({}, saved), fetchGit: vi.fn().mockRejectedValue(new Error('offline')) }
    await expect(updatePlugin(installed, d)).resolves.toEqual({ kind: 'failed' })
    expect(saved).toHaveLength(0)
  })

  it('is unchanged for a plugin with nowhere to update from', async () => {
    const orphan = { ...installed, origin: { kind: 'file' as const, fileName: 'p.js', updateUrl: null } }
    await expect(updatePlugin(orphan, deps({}))).resolves.toEqual({ kind: 'unchanged' })
  })
})

describe('approvePendingUpdate', () => {
  it('applies the held version and widens the approved hosts', async () => {
    const held: InstalledPlugin = {
      ...installed,
      pendingUpdate: {
        source: 'new', sha256: 'new-hash',
        manifest: manifestOf({ version: '2.0.0', hosts: ['a.com', 'b.com'] }),
        commit: 'bbb', newHosts: ['b.com'],
      },
    }
    const saved: InstalledPlugin[] = []
    const applied = await approvePendingUpdate(held, { save: async (p) => { saved.push(p) } })
    expect(applied.source).toBe('new')
    expect(applied.approvedHosts).toEqual(['a.com', 'b.com'])
    expect(applied.pendingUpdate).toBeNull()
    expect(saved).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plugins/update.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/plugins/update.ts
import { fetchGitPlugin, readManifestFromSource, type InstallDeps } from './install'
import { listPlugins, putPlugin, sha256Hex, type InstalledPlugin } from './store'
import type { PluginManifest as Manifest } from './manifest'

export interface UpdateDeps extends InstallDeps {
  fetchGit?: (repoUrl: string, deps?: InstallDeps) => Promise<{ source: string; commit: string }>
  save?: (plugin: InstalledPlugin) => Promise<void>
}

export type UpdateOutcome =
  | { kind: 'unchanged' }
  | { kind: 'applied'; version: string }
  | { kind: 'held'; newHosts: string[] }
  | { kind: 'refused'; reason: 'origin-changed' }
  | { kind: 'failed' }

/** The address a plugin updates from, whichever way it was installed. */
export function updateUrlOf(plugin: InstalledPlugin): string | null {
  return plugin.origin.kind === 'git' ? plugin.origin.updateUrl : plugin.origin.updateUrl
}

export async function updatePlugin(plugin: InstalledPlugin, deps: UpdateDeps = {}): Promise<UpdateOutcome> {
  const address = updateUrlOf(plugin)
  if (!address) return { kind: 'unchanged' }

  const fetchGit = deps.fetchGit ?? fetchGitPlugin
  const readManifest = deps.readManifest ?? readManifestFromSource
  const save = deps.save ?? putPlugin

  let fetched: { source: string; commit: string }
  try {
    fetched = await fetchGit(address, deps)
  } catch {
    // Offline, rate limited, repository gone: keep what is installed. An
    // update that cannot be checked is not an update that failed to apply.
    return { kind: 'failed' }
  }

  const currentCommit = plugin.origin.kind === 'git' ? plugin.origin.commit : ''
  if (fetched.commit !== '' && fetched.commit === currentCommit) return { kind: 'unchanged' }

  const sha256 = await sha256Hex(fetched.source)
  if (sha256 === plugin.sha256) return { kind: 'unchanged' }

  let manifest: Manifest
  try {
    manifest = await readManifest(fetched.source)
  } catch {
    return { kind: 'failed' }
  }

  // The address is the identity. A version that points its own updates
  // somewhere else is a different plugin wearing this one's name, and
  // installing it is a decision a person makes, not one an update makes.
  if (manifest.updateUrl !== null && manifest.updateUrl !== address) {
    return { kind: 'refused', reason: 'origin-changed' }
  }

  const newHosts = manifest.hosts.filter((host) => !plugin.approvedHosts.includes(host))
  if (newHosts.length > 0) {
    await save({
      ...plugin,
      pendingUpdate: { source: fetched.source, sha256, manifest, commit: fetched.commit, newHosts },
    })
    return { kind: 'held', newHosts }
  }

  await save({
    ...plugin,
    manifest,
    source: fetched.source,
    sha256,
    origin: plugin.origin.kind === 'git'
      ? { ...plugin.origin, commit: fetched.commit }
      : plugin.origin,
    pendingUpdate: null,
  })
  return { kind: 'applied', version: manifest.version }
}

export async function approvePendingUpdate(
  plugin: InstalledPlugin,
  deps: Pick<UpdateDeps, 'save'> = {},
): Promise<InstalledPlugin> {
  const save = deps.save ?? putPlugin
  const pending = plugin.pendingUpdate
  if (!pending) return plugin
  const applied: InstalledPlugin = {
    ...plugin,
    manifest: pending.manifest,
    source: pending.source,
    sha256: pending.sha256,
    approvedHosts: [...pending.manifest.hosts],
    origin: plugin.origin.kind === 'git' ? { ...plugin.origin, commit: pending.commit } : plugin.origin,
    pendingUpdate: null,
  }
  await save(applied)
  return applied
}

/** Runs on every load. Whatever fails, fails quietly and keeps what is there. */
export async function updateAll(deps: UpdateDeps = {}): Promise<Record<string, UpdateOutcome>> {
  const plugins = await listPlugins()
  const entries = await Promise.all(plugins.map(async (plugin) => (
    [plugin.id, await updatePlugin(plugin, deps)] as const
  )))
  return Object.fromEntries(entries)
}

```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/plugins/update.test.ts && npx tsc -b`
Expected: PASS, 11 testes, e `tsc` limpo.

- [ ] **Step 5: Commit**

```bash
git add web/src/plugins/update.ts web/src/plugins/update.test.ts
git commit -m "feat: update plugins from their locked origin, holding new hosts for consent"
```

---

### Task 8: Streams com localização — torrent ou URL

**Files:**
- Modify: `web/src/catalog/streams.ts`
- Modify: `web/src/catalog/streams.test.ts`
- Modify: `web/src/catalog/openStream.ts`
- Modify: `web/src/catalog/MetaDetails.tsx:504`

**Interfaces:**
- Consumes: nada novo.
- Produces:
  - `type StreamLocation = { kind: 'torrent'; infoHash: string; fileIdx: number | null; fileName: string } | { kind: 'url'; url: string }`
  - `CatalogStream` perde `infoHash`, `fileName` e `fileIdx` do topo e ganha `location: StreamLocation` e `pluginId: string`.
  - `buildMagnet(location: Extract<StreamLocation, { kind: 'torrent' }>, label: string): string`
  - `streamKey(stream: CatalogStream): string`

- [ ] **Step 1: Write the failing test**

Substitua o bloco `describe('parseStreams', ...)` de `web/src/catalog/streams.test.ts` por:

```ts
describe('parseStreams', () => {
  it('reads a torrent stream into a torrent location', () => {
    const [stream] = parseStreams({
      streams: [{
        name: 'Torrentio\n1080p', title: 'Movie.1080p\n👤 9 💾 2 GB ⚙️ X',
        infoHash: 'A'.repeat(40), fileIdx: 3, behaviorHints: { filename: 'Movie.mkv' },
      }],
    }, 'torrentio')
    expect(stream.location).toEqual({ kind: 'torrent', infoHash: 'a'.repeat(40), fileIdx: 3, fileName: 'Movie.mkv' })
    expect(stream.pluginId).toBe('torrentio')
    expect(stream.resolution).toBe('1080p')
  })

  it('reads a direct https url into a url location', () => {
    const [stream] = parseStreams({
      streams: [{ name: 'Mirror\n720p', title: 'Movie.720p', url: 'https://cdn.example.com/movie.mkv' }],
    }, 'mirrors')
    expect(stream.location).toEqual({ kind: 'url', url: 'https://cdn.example.com/movie.mkv' })
  })

  it('drops a stream that points nowhere, and one that points over http', () => {
    expect(parseStreams({ streams: [{ name: 'x', title: 'y' }] }, 'p')).toEqual([])
    expect(parseStreams({ streams: [{ url: 'http://cdn.example.com/m.mkv' }] }, 'p')).toEqual([])
    expect(parseStreams({ streams: [{ infoHash: 'nothex' }] }, 'p')).toEqual([])
  })

  it('survives a payload that is not the shape it should be', () => {
    expect(parseStreams(null, 'p')).toEqual([])
    expect(parseStreams({ streams: 'no' }, 'p')).toEqual([])
  })
})

describe('buildMagnet', () => {
  it('builds a magnet from a torrent location', () => {
    const magnet = buildMagnet({ kind: 'torrent', infoHash: 'b'.repeat(40), fileIdx: null, fileName: 'F.mkv' }, 'F')
    expect(magnet.startsWith(`magnet:?xt=urn:btih:${'b'.repeat(40)}&dn=F.mkv`)).toBe(true)
    expect(magnet).toContain('tracker.opentrackr.org')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/catalog/streams.test.ts`
Expected: FAIL — `parseStreams` recebe dois argumentos e `stream.location` não existe.

- [ ] **Step 3: Write the implementation**

Em `web/src/catalog/streams.ts`, troque a interface e as duas funções finais.

`ADDON_BASE` e `fetchStreams` **ficam onde estão nesta task**, com uma única mudança: a chamada de `parseStreams` dentro de `fetchStreams` passa a receber `'torrentio'` como segundo argumento. Eles são o que o sistema de plugins substitui, e a Task 9 os deleta — mas deletá-los aqui quebraria `MetaDetails.tsx` numa task que ainda não tem com o que consertá-lo, e uma task que não compila não é uma task.

```ts

/** Where a stream's bytes actually are. */
export type StreamLocation =
  | { kind: 'torrent'; infoHash: string; fileIdx: number | null; fileName: string }
  | { kind: 'url'; url: string }

export interface CatalogStream {
  quality: string
  resolution: StreamResolution
  label: string
  seeders: number | null
  size: string
  source: string
  languages: string[]
  location: StreamLocation
  /** Which plugin produced this, so a bad source can be traced to its author. */
  pluginId: string
}

function readLocation(stream: Record<string, unknown>): StreamLocation | null {
  if (typeof stream.infoHash === 'string' && /^[0-9a-f]{40}$/i.test(stream.infoHash)) {
    const hints = typeof stream.behaviorHints === 'object' && stream.behaviorHints !== null
      ? stream.behaviorHints as Record<string, unknown>
      : {}
    return {
      kind: 'torrent',
      infoHash: stream.infoHash.toLowerCase(),
      fileIdx: typeof stream.fileIdx === 'number' && Number.isInteger(stream.fileIdx) && stream.fileIdx >= 0
        ? stream.fileIdx
        : null,
      fileName: typeof hints.filename === 'string' ? hints.filename : '',
    }
  }
  if (typeof stream.url === 'string') {
    try {
      // http is refused here rather than at play time: a source the room
      // could not fetch anyway should not be offered as if it could.
      if (new URL(stream.url).protocol === 'https:') return { kind: 'url', url: stream.url }
    } catch {
      return null
    }
  }
  return null
}

export function parseStreams(payload: unknown, pluginId: string): CatalogStream[] {
  if (typeof payload !== 'object' || payload === null) return []
  const streams = (payload as { streams?: unknown }).streams
  if (!Array.isArray(streams)) return []
  const result: CatalogStream[] = []
  for (const value of streams) {
    if (typeof value !== 'object' || value === null) continue
    const stream = value as Record<string, unknown>
    const location = readLocation(stream)
    if (!location) continue
    const parsed = parseStreamTitle(typeof stream.title === 'string' ? stream.title : '')
    const quality = typeof stream.name === 'string' ? stream.name.split('\n').slice(1).join(' ') || stream.name : ''
    result.push({
      quality,
      resolution: streamResolution(quality, parsed.label),
      ...parsed,
      location,
      pluginId,
    })
  }
  return result
}

export function buildMagnet(location: Extract<StreamLocation, { kind: 'torrent' }>, label: string): string {
  const name = location.fileName || label
  const dn = name ? `&dn=${encodeURIComponent(name)}` : ''
  const trackers = TRACKERS.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join('')
  return `magnet:?xt=urn:btih:${location.infoHash}${dn}${trackers}`
}

/** A stable identity for a row in the source list. */
export function streamKey(stream: CatalogStream): string {
  return stream.location.kind === 'torrent'
    ? `${stream.pluginId}:${stream.location.infoHash}:${stream.location.fileIdx ?? ''}:${stream.location.fileName}`
    : `${stream.pluginId}:${stream.location.url}`
}
```

Em `web/src/catalog/openStream.ts`, restrinja a assinatura ao caso torrent:

```ts
import { openTorrent, type TorrentSession, type TorrentVideoFile } from '../torrent'
import { buildMagnet, type CatalogStream, type StreamLocation } from './streams'

/**
 * Opens a torrent stream and picks the video file it points at. URL streams
 * never come through here: they have no swarm and no file list, and the
 * server fetches them directly.
 */
export async function openCatalogStream(
  stream: CatalogStream & { location: Extract<StreamLocation, { kind: 'torrent' }> },
  onStats?: Parameters<typeof openTorrent>[1],
): Promise<{ file: TorrentVideoFile; session: TorrentSession }> {
  const { location } = stream
  const session = await openTorrent(buildMagnet(location, stream.label), onStats)
  const file = (location.fileName ? session.files.find((candidate) => candidate.name === location.fileName) : undefined)
    ?? (location.fileIdx !== null ? session.files.find((candidate) => candidate.index === location.fileIdx) : undefined)
    ?? session.files[0]
  if (!file) {
    session.destroy()
    throw new Error('stream torrent has no playable video file')
  }
  return { file, session }
}
```

Em `web/src/catalog/MetaDetails.tsx`, linha 504, troque a chave por `key={`${streamKey(stream)}:${index}`}` e acrescente `streamKey` ao import de `./streams`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/catalog/streams.test.ts && npx tsc -b`
Run: `cd web && npx vitest run && npx tsc -b && npx oxlint src`
Expected: verde. `MetaDetails.tsx` continua compilando porque `fetchStreams` continua existindo e a linha 504 agora usa `streamKey`.

- [ ] **Step 5: Commit**

```bash
git add web/src/catalog/streams.ts web/src/catalog/streams.test.ts web/src/catalog/openStream.ts web/src/catalog/MetaDetails.tsx
git commit -m "feat: describe a stream by where its bytes are"
```

---

### Task 9: `resolveStreams` e os três estados vazios

**Files:**
- Create: `web/src/plugins/resolve.ts`
- Test: `web/src/plugins/resolve.test.ts`
- Modify: `web/src/catalog/streams.ts` (remover `ADDON_BASE` e `fetchStreams`)
- Modify: `web/src/catalog/MetaDetails.tsx` (linhas 88-97 e 477-495)
- Modify: `web/src/i18n/pt-BR.ts`, `web/src/i18n/en.ts`

**Interfaces:**
- Consumes: `runPlugin`/`PluginRunError` (Task 3), `spawnPluginWorker`/`pageFetch` (Task 4), `listPlugins` (Task 5), `parseStreams`/`CatalogStream`/`StreamTarget` (Task 8).
- Produces: `type ResolveResult = { kind: 'no-plugins' } | { kind: 'streams'; streams: CatalogStream[] }` e `resolveStreams(target: StreamTarget, deps?: ResolveDeps): Promise<ResolveResult>` com `ResolveDeps = { load?: () => Promise<InstalledPlugin[]>; run?: (plugin: InstalledPlugin, target: StreamTarget) => Promise<unknown> }`.

- [ ] **Step 1: Write the failing test**

```ts
// web/src/plugins/resolve.test.ts
import { describe, expect, it, vi } from 'vitest'
import { resolveStreams } from './resolve'
import type { InstalledPlugin } from './store'

const plugin = (id: string, enabled = true): InstalledPlugin => ({
  id,
  manifest: { id, name: id, version: '1', hosts: ['a.com'], updateUrl: null },
  source: '', sha256: '', origin: { kind: 'file', fileName: `${id}.js`, updateUrl: null },
  approvedHosts: ['a.com'], enabled, pendingUpdate: null, installedAt: 1,
})

const target = { type: 'movie' as const, id: 'tt0111161' }
// What a plugin returns is the bare array; the wrapping into `{ streams }`
// that parseStreams wants happens inside resolveStreams.
const torrent = (hash: string) => [{ name: 'X\n1080p', title: 'R', infoHash: hash }]

describe('resolveStreams', () => {
  it('reports that nothing is installed, which is a different problem from finding nothing', async () => {
    await expect(resolveStreams(target, { load: async () => [] })).resolves.toEqual({ kind: 'no-plugins' })
  })

  it('reports no plugins when every installed one is switched off', async () => {
    await expect(resolveStreams(target, { load: async () => [plugin('a', false)] }))
      .resolves.toEqual({ kind: 'no-plugins' })
  })

  it('concatenates what the enabled plugins returned, tagged with who returned it', async () => {
    const result = await resolveStreams(target, {
      load: async () => [plugin('a'), plugin('b')],
      run: async (p) => torrent(p.id === 'a' ? 'a'.repeat(40) : 'b'.repeat(40)),
    })
    if (result.kind !== 'streams') throw new Error('expected streams')
    expect(result.streams.map((s) => s.pluginId)).toEqual(['a', 'b'])
  })

  it('returns an empty list rather than nothing when plugins ran and found none', async () => {
    await expect(resolveStreams(target, { load: async () => [plugin('a')], run: async () => [] }))
      .resolves.toEqual({ kind: 'streams', streams: [] })
  })

  it('keeps one plugin failing from taking the others down', async () => {
    const run = vi.fn(async (p: InstalledPlugin) => {
      if (p.id === 'a') throw new Error('boom')
      return torrent('b'.repeat(40))
    })
    const result = await resolveStreams(target, { load: async () => [plugin('a'), plugin('b')], run })
    if (result.kind !== 'streams') throw new Error('expected streams')
    expect(result.streams).toHaveLength(1)
    expect(result.streams[0].pluginId).toBe('b')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plugins/resolve.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/plugins/resolve.ts
import { parseStreams, type CatalogStream, type StreamTarget } from '../catalog/streams'
import { runPlugin } from './runtime'
import { pageFetch, spawnPluginWorker } from './spawn'
import { listPlugins, type InstalledPlugin } from './store'

export type ResolveResult =
  | { kind: 'no-plugins' }
  | { kind: 'streams'; streams: CatalogStream[] }

export interface ResolveDeps {
  load?: () => Promise<InstalledPlugin[]>
  run?: (plugin: InstalledPlugin, target: StreamTarget) => Promise<unknown>
}

function runInWorker(plugin: InstalledPlugin, target: StreamTarget): Promise<unknown> {
  return runPlugin({
    hosts: plugin.approvedHosts,
    selfOrigin: window.location.origin,
    spawn: spawnPluginWorker(plugin.source, target),
    fetchUrl: pageFetch,
  })
}

/**
 * Asks every enabled plugin for this title at once.
 *
 * "Nothing installed" and "installed, found nothing" are separate answers on
 * purpose: they are separate problems, and only one of them is fixed by
 * installing something.
 */
export async function resolveStreams(target: StreamTarget, deps: ResolveDeps = {}): Promise<ResolveResult> {
  const load = deps.load ?? listPlugins
  const run = deps.run ?? runInWorker

  const enabled = (await load()).filter((plugin) => plugin.enabled)
  if (enabled.length === 0) return { kind: 'no-plugins' }

  const settled = await Promise.allSettled(enabled.map(async (plugin) => (
    parseStreams({ streams: await run(plugin, target) }, plugin.id)
  )))
  const streams = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  return { kind: 'streams', streams }
}
```

Note que `run` devolve o array cru do plugin e `parseStreams` espera `{ streams }` — o embrulho acontece aqui, o que deixa o plugin devolvendo simplesmente um array.

- [ ] **Step 4: Wire MetaDetails and delete the hardcoded addon**

Primeiro, em `web/src/catalog/streams.ts`, apague a constante `ADDON_BASE` e a função `fetchStreams` inteiras, junto com o comentário do topo que fala do addon. Agora existe um chamador melhor, e um endereço de addon embutido é exatamente o que este sistema substitui. `MetaDetails.tsx` é o único importador de `fetchStreams`, e os passos abaixo o reescrevem.

Depois, em `web/src/catalog/MetaDetails.tsx`:

1. Troque o import `fetchStreams` por `import { resolveStreams } from '../plugins/resolve'` e mantenha os tipos vindos de `./streams`.
2. Acrescente o estado `const [noPlugins, setNoPlugins] = useState(false)`.
3. Substitua o efeito das linhas 87-97 por:

```tsx
  useEffect(() => {
    // A viewer never sees this list — they see the button that asks the host.
    // Resolving anyway would run plugins to build something the interface
    // throws away, and would make a viewer need a plugin installed.
    if (!target || mode === 'viewer') return
    let cancelled = false
    setStreams(null)
    setStreamsFailed(false)
    setNoPlugins(false)
    resolveStreams(target)
      .then((result) => {
        if (cancelled) return
        if (result.kind === 'no-plugins') {
          setNoPlugins(true)
          setStreams([])
          return
        }
        setStreams(result.streams)
      })
      .catch(() => { if (!cancelled) setStreamsFailed(true) })
    return () => { cancelled = true }
  }, [target, mode])
```

4. No bloco vazio das linhas 488-492, separe os dois casos:

```tsx
              ) : streamsFailed || streams === null ? (
                <p className="empty-copy">{t('details.sourcesFailed')}</p>
              ) : noPlugins ? (
                <p className="empty-copy">
                  {t('details.noPlugins')}{' '}
                  <button type="button" className="catalog-retry" onClick={onOpenPlugins}>
                    {t('details.installPlugin')}
                  </button>
                </p>
              ) : streams.length === 0 ? (
                <p className="empty-copy">
                  {t('details.noSources')}{' '}
                  <button type="button" className="catalog-retry" onClick={onOpenPlugins}>
                    {t('details.installPlugin')}
                  </button>
                </p>
              ) : visibleStreams.length === 0 ? (
```

5. Acrescente `onOpenPlugins: () => void` às props de `MetaDetails` e repasse-a a partir de `CatalogOverlay` e de `Home` — a Task 10 é quem fornece a função.

- [ ] **Step 5: Add the strings**

Em `web/src/i18n/pt-BR.ts`, junto das outras `details.*`:

```ts
  'details.noPlugins': 'Nenhum plugin instalado — sem um, não há de onde tirar as fontes.',
  'details.noSources': 'Nenhum plugin conseguiu reproduzir essa mídia.',
  'details.installPlugin': 'Instalar plugin',
```

Em `web/src/i18n/en.ts`:

```ts
  'details.noPlugins': 'No plugins installed — without one there is nowhere for sources to come from.',
  'details.noSources': 'No plugin could play this.',
  'details.installPlugin': 'Install a plugin',
```

`details.noSources` já existe: substitua o valor, não acrescente uma segunda chave.

- [ ] **Step 6: Run the suite**

Run: `cd web && npm run test && npx tsc -b && npm run lint`
Expected: tudo verde, exceto o que a Task 12 vai consertar em `Home.tsx`/`Room.tsx` (chamada de `openCatalogStream` sem o estreitamento de tipo). Se `tsc` reclamar disso, aplique já o estreitamento mínimo:

```tsx
if (pick.stream.location.kind !== 'torrent') throw new Error('url sources arrive in task 12')
const opened = await openCatalogStream(pick.stream as Parameters<typeof openCatalogStream>[0])
```

- [ ] **Step 7: Commit**

```bash
git add web/src/catalog/streams.ts web/src/catalog/streams.test.ts web/src/catalog/openStream.ts \
  web/src/catalog/MetaDetails.tsx web/src/plugins/resolve.ts web/src/plugins/resolve.test.ts \
  web/src/i18n/pt-BR.ts web/src/i18n/en.ts
git commit -m "feat: resolve sources through installed plugins"
```

---

### Task 10: O painel de plugins

**Files:**
- Create: `web/src/plugins/PluginsPanel.tsx`
- Test: `web/src/plugins/PluginsPanel.test.tsx`
- Modify: `web/src/pages/Home.tsx` (header e estado do painel)
- Modify: `web/src/catalog/CatalogOverlay.tsx` (mesmo botão dentro da sala)
- Modify: `web/src/theme.css`
- Modify: `web/src/i18n/pt-BR.ts`, `web/src/i18n/en.ts`

**Interfaces:**
- Consumes: `listPlugins`/`putPlugin`/`deletePlugin`/`InstalledPlugin` (Task 5), `buildInstall`/`fetchGitPlugin`/`readManifestFromSource` (Task 6), `updateAll`/`approvePendingUpdate` (Task 7), e a prop `onOpenPlugins` que a **Task 9** acrescentou a `MetaDetailsProps` — sem ela o passo 5 não compila.
- Produces: `<PluginsPanel open={boolean} onClose={() => void} />`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/plugins/PluginsPanel.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginsPanel } from './PluginsPanel'
import { deletePlugin, listPlugins, putPlugin, type InstalledPlugin } from './store'

vi.mock('./install', async () => {
  const actual = await vi.importActual<typeof import('./install')>('./install')
  return {
    ...actual,
    readManifestFromSource: vi.fn(async () => ({
      id: 'torrentio', name: 'Torrentio', version: '1.0.0', hosts: ['torrentio.strem.fun'], updateUrl: null,
    })),
    fetchGitPlugin: vi.fn(async () => ({ source: 'export const manifest = {}', commit: 'abc' })),
  }
})

// There is no I18nProvider in this repository: `useT` (web/src/i18n/useT.ts,
// not .tsx) is a per-component hook that reads localStorage['ss.language'] and
// falls back to pt-BR. Nothing to wrap.
const show = () => render(<PluginsPanel open onClose={() => undefined} />)

const existing: InstalledPlugin = {
  id: 'mirrors',
  manifest: { id: 'mirrors', name: 'Mirrors', version: '2.1.0', hosts: ['cdn.example.com'], updateUrl: null },
  source: '', sha256: 'a'.repeat(64),
  origin: { kind: 'file', fileName: 'mirrors.js', updateUrl: null },
  approvedHosts: ['cdn.example.com'], enabled: true, pendingUpdate: null, installedAt: 1,
}

describe('PluginsPanel', () => {
  beforeEach(async () => {
    for (const plugin of await listPlugins()) await deletePlugin(plugin.id)
  })

  it('invites you to add one when the list is empty', async () => {
    show()
    expect(await screen.findByText(/nenhum plugin instalado/i)).toBeInTheDocument()
  })

  it('lists an installed plugin with its version and where it came from', async () => {
    await putPlugin(existing)
    show()
    expect(await screen.findByText('Mirrors')).toBeInTheDocument()
    expect(screen.getByText(/2\.1\.0/)).toBeInTheDocument()
    expect(screen.getByText(/mirrors\.js/)).toBeInTheDocument()
  })

  it('shows the hosts a candidate wants before anything is stored', async () => {
    show()
    await userEvent.click(await screen.findByRole('button', { name: /adicionar/i }))
    await userEvent.type(screen.getByLabelText(/endereço do repositório/i), 'https://github.com/u/r')
    await userEvent.click(screen.getByRole('button', { name: /buscar/i }))
    expect(await screen.findByText('torrentio.strem.fun')).toBeInTheDocument()
    expect(await listPlugins()).toHaveLength(0)
  })

  it('stores the plugin only after the confirmation', async () => {
    show()
    await userEvent.click(await screen.findByRole('button', { name: /adicionar/i }))
    await userEvent.type(screen.getByLabelText(/endereço do repositório/i), 'https://github.com/u/r')
    await userEvent.click(screen.getByRole('button', { name: /buscar/i }))
    await userEvent.click(await screen.findByRole('button', { name: /^instalar$/i }))
    await waitFor(async () => expect(await listPlugins()).toHaveLength(1))
  })

  it('removes a plugin', async () => {
    await putPlugin(existing)
    show()
    await userEvent.click(await screen.findByRole('button', { name: /remover mirrors/i }))
    await waitFor(async () => expect(await listPlugins()).toHaveLength(0))
  })

  it('switches a plugin off without removing it', async () => {
    await putPlugin(existing)
    show()
    await userEvent.click(await screen.findByRole('checkbox', { name: /ativar mirrors/i }))
    await waitFor(async () => expect((await listPlugins())[0]?.enabled).toBe(false))
  })

  it('offers to update everything only when something has somewhere to update from', async () => {
    await putPlugin(existing)   // origin: file, updateUrl null — nowhere to go
    show()
    expect(await screen.findByText('Mirrors')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /atualizar todos/i })).toBeNull()

    await putPlugin({ ...existing, id: 'repo', origin: { kind: 'git', updateUrl: 'https://github.com/u/r', commit: 'a' } })
    show()
    expect(await screen.findByRole('button', { name: /atualizar todos/i })).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    const onClose = vi.fn()
    render(<PluginsPanel open onClose={onClose} />)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('names the new hosts of a held update', async () => {
    await putPlugin({
      ...existing,
      pendingUpdate: {
        source: '', sha256: 'b'.repeat(64),
        manifest: { ...existing.manifest, version: '3.0.0', hosts: ['cdn.example.com', 'tracker.new.com'] },
        commit: 'ccc', newHosts: ['tracker.new.com'],
      },
    })
    show()
    expect(await screen.findByText(/tracker\.new\.com/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /aprovar/i })).toBeInTheDocument()
  })
})
```

As asserções em português acima funcionam sem configuração: sem chave no `localStorage`, `normalizeLanguage` devolve `pt-BR`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plugins/PluginsPanel.test.tsx`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write the component**

```tsx
// web/src/plugins/PluginsPanel.tsx
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Puzzle, Trash2, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { MorphPanel } from '../ui/MorphPanel'
import { useMorphingStep } from '../ui/useMorphingStep'
import { StepBack } from '../ui/StepBack'
import { buildInstall, fetchGitPlugin, readManifestFromSource } from './install'
import { deletePlugin, listPlugins, putPlugin, type InstalledPlugin } from './store'
import { approvePendingUpdate, updateAll, updateUrlOf } from './update'
import type { PluginManifest } from './manifest'
import type { PluginOrigin } from './store'

type Step = 'list' | 'add'

/** A plugin read but not yet stored — what the confirmation screen shows. */
interface Candidate {
  source: string
  manifest: PluginManifest
  origin: PluginOrigin
}

export function PluginsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT()
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null)
  const [step, setStep] = useState<Step>('list')
  const [repoUrl, setRepoUrl] = useState('')
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // `shown` is the step one beat behind `step`, so the outgoing content
  // dissolves before the next one mounts. Rendering from `step` and using
  // only `morphing` would defeat the hook — compare Home.tsx:91 and 325.
  const view = candidate ? 'confirm' : step
  const { shown, morphing } = useMorphingStep(view)

  const refresh = useCallback(async () => setInstalled(await listPlugins()), [])

  useEffect(() => { if (open) void refresh() }, [open, refresh])

  const read = async (source: string, origin: PluginOrigin) => {
    setBusy(true)
    setError(null)
    try {
      setCandidate({ source, manifest: await readManifestFromSource(source), origin })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const fromRepo = async () => {
    setBusy(true)
    setError(null)
    try {
      const { source, commit } = await fetchGitPlugin(repoUrl.trim())
      await read(source, { kind: 'git', updateUrl: repoUrl.trim(), commit })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const fromFile = async (file: File) => {
    await read(await file.text(), { kind: 'file', fileName: file.name, updateUrl: null })
  }

  const confirm = async () => {
    if (!candidate) return
    await putPlugin(await buildInstall(candidate.source, candidate.origin, {
      readManifest: () => Promise.resolve(candidate.manifest),
    }))
    setCandidate(null)
    setRepoUrl('')
    setStep('list')
    await refresh()
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) void fromFile(file)
  }

  // Escape closes, and the page behind stops scrolling — both are what
  // MetaDetails does (MetaDetails.tsx:228-243) and what the Radix dialog on
  // the manual upload gives for free.
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return (
    // The backdrop closes only when the backdrop itself is clicked. A plain
    // onClick here also fires for clicks on the MorphPanel's own frame, which
    // sits outside the panel's stopPropagation.
    <div
      className="plugins-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('plugins.title')}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <MorphPanel sizeKey={shown} morphing={morphing} className="plugins-morph">
        <div className="plugins-panel" onClick={(event) => event.stopPropagation()}>
          <button type="button" className="plugins-close" aria-label={t('plugins.close')} onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>

          <AnimatePresence mode="wait" initial={false}>
            {shown === 'confirm' && candidate ? (
              <motion.div key="confirm" className="plugins-step">
                <StepBack label={t('plugins.back')} onClick={() => setCandidate(null)} />
                <h2>{candidate.manifest.name}</h2>
                <p className="plugins-version">{candidate.manifest.version}</p>
                <p className="plugins-note">{t('plugins.willReach')}</p>
                <ul className="plugins-hosts">
                  {candidate.manifest.hosts.map((host) => <li key={host}>{host}</li>)}
                </ul>
                {/* A file that fetches code from an address you did not type
                    is worth saying out loud. */}
                {candidate.manifest.updateUrl ? (
                  <p className="plugins-note">{t('plugins.updatesFrom')} {candidate.manifest.updateUrl}</p>
                ) : null}
                <button type="button" className="primary-button raised" onClick={() => void confirm()}>
                  {t('plugins.install')}
                </button>
              </motion.div>
            ) : shown === 'add' ? (
              <motion.div key="add" className="plugins-step">
                <StepBack label={t('plugins.back')} onClick={() => setStep('list')} />
                <button
                  type="button"
                  className="plugins-drop"
                  onClick={() => fileRef.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={onDrop}
                >
                  {t('plugins.dropHint')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".js,text/javascript"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void fromFile(file)
                  }}
                />
                <label className="plugins-url">
                  <span>{t('plugins.repoLabel')}</span>
                  <input
                    type="url"
                    value={repoUrl}
                    placeholder="https://github.com/user/repo"
                    onChange={(event) => setRepoUrl(event.target.value)}
                  />
                </label>
                <button type="button" className="primary-button" disabled={busy || repoUrl.trim() === ''} onClick={() => void fromRepo()}>
                  {t('plugins.fetch')}
                </button>
                {error ? <p className="empty-copy">{error}</p> : null}
              </motion.div>
            ) : (
              <motion.div key="list" className="plugins-step">
                <h2>{t('plugins.title')}</h2>
                {installed === null ? null : installed.length === 0 ? (
                  <p className="empty-copy">{t('plugins.empty')}</p>
                ) : (
                  <ul className="plugins-list">
                    {installed.map((plugin) => (
                      <li key={plugin.id}>
                        <span className="plugins-name">{plugin.manifest.name}</span>
                        <span className="plugins-meta">
                          {plugin.manifest.version} · {plugin.origin.kind === 'git' ? plugin.origin.updateUrl : plugin.origin.fileName}
                        </span>
                        <code className="plugins-hash">{plugin.sha256.slice(0, 12)}</code>
                        <input
                          type="checkbox"
                          checked={plugin.enabled}
                          aria-label={`${t('plugins.enable')} ${plugin.manifest.name}`}
                          onChange={async () => {
                            await putPlugin({ ...plugin, enabled: !plugin.enabled })
                            await refresh()
                          }}
                        />
                        <button
                          type="button"
                          aria-label={`${t('plugins.remove')} ${plugin.manifest.name}`}
                          onClick={async () => { await deletePlugin(plugin.id); await refresh() }}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                        {plugin.pendingUpdate ? (
                          <div className="plugins-held">
                            <p>{t('plugins.heldUpdate')} {plugin.pendingUpdate.newHosts.join(', ')}</p>
                            <button
                              type="button"
                              onClick={async () => { await approvePendingUpdate(plugin); await refresh() }}
                            >
                              {t('plugins.approve')}
                            </button>
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="plugins-actions">
                  <button type="button" className="primary-button raised" onClick={() => setStep('add')}>
                    <Puzzle size={15} aria-hidden="true" />{t('plugins.add')}
                  </button>
                  {installed && installed.some((plugin) => updateUrlOf(plugin) !== null) ? (
                    <button type="button" onClick={async () => { await updateAll(); await refresh() }}>
                      {t('plugins.updateAll')}
                    </button>
                  ) : null}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </MorphPanel>
    </div>
  )
}
```

- [ ] **Step 4: Add the strings**

`web/src/i18n/pt-BR.ts`:

```ts
  'plugins.title': 'Plugins',
  'plugins.open': 'Plugins',
  'plugins.close': 'Fechar plugins',
  'plugins.back': 'Voltar',
  'plugins.empty': 'Nenhum plugin instalado.',
  'plugins.add': 'Adicionar',
  'plugins.updateAll': 'Atualizar todos',
  'plugins.remove': 'Remover',
  'plugins.enable': 'Ativar',
  'plugins.dropHint': 'Arraste um plugin aqui ou clique para escolher',
  'plugins.repoLabel': 'Endereço do repositório',
  'plugins.fetch': 'Buscar',
  'plugins.install': 'Instalar',
  'plugins.willReach': 'Este plugin vai alcançar:',
  'plugins.updatesFrom': 'Atualiza sozinho a partir de',
  'plugins.heldUpdate': 'Uma versão nova está esperando aval — ela quer alcançar:',
  'plugins.approve': 'Aprovar',
```

`web/src/i18n/en.ts`:

```ts
  'plugins.title': 'Plugins',
  'plugins.open': 'Plugins',
  'plugins.close': 'Close plugins',
  'plugins.back': 'Back',
  'plugins.empty': 'No plugins installed.',
  'plugins.add': 'Add',
  'plugins.updateAll': 'Update all',
  'plugins.remove': 'Remove',
  'plugins.enable': 'Enable',
  'plugins.dropHint': 'Drop a plugin here, or click to choose one',
  'plugins.repoLabel': 'Repository address',
  'plugins.fetch': 'Fetch',
  'plugins.install': 'Install',
  'plugins.willReach': 'This plugin will reach:',
  'plugins.updatesFrom': 'Updates itself from',
  'plugins.heldUpdate': 'A new version is waiting on you — it wants to reach:',
  'plugins.approve': 'Approve',
```

- [ ] **Step 5: Mount it in the header**

Em `web/src/pages/Home.tsx`, dentro de `.header-end` e antes do botão `.header-upload`:

```tsx
          <button type="button" className="header-plugins" onClick={() => setPluginsOpen(true)}>
            <Puzzle size={15} aria-hidden="true" />{t('plugins.open')}
          </button>
```

com `const [pluginsOpen, setPluginsOpen] = useState(false)` no componente, `<PluginsPanel open={pluginsOpen} onClose={() => setPluginsOpen(false)} />` junto dos outros overlays, `onOpenPlugins={() => setPluginsOpen(true)}` no `<MetaDetails>`, e `import { Puzzle } from 'lucide-react'`.

Repita o par botão/painel em `web/src/catalog/CatalogOverlay.tsx`, para que o catálogo aberto de dentro de uma sala tenha o mesmo caminho. O cabeçalho lá é `<header className="catalog-overlay-head">` (linha 65) e não tem `.header-end`: o botão entra entre o `<h1>` e o `.dialog-close`.

```tsx
        <h1>{t('catalog.tab')}</h1>
        <button type="button" className="header-plugins" onClick={() => setPluginsOpen(true)}>
          <Puzzle size={15} aria-hidden="true" />{t('plugins.open')}
        </button>
        <button type="button" className="dialog-close" aria-label={t('details.close')} onClick={onClose}>
```

E repasse `onOpenPlugins={() => setPluginsOpen(true)}` ao `<MetaDetails>` que o overlay já renderiza (linha 76).

- [ ] **Step 6: Style it**

Em `web/src/theme.css`, ao lado do bloco `--- catalog header ---`:

```css
/* --- plugins ------------------------------------------------------------ */
.header-plugins { padding: 9px 14px; border: 0; border-radius: 999px; color: var(--text-dim); background: transparent; font-size: 13px; display: inline-flex; align-items: center; gap: 7px; }
.header-plugins:hover { color: var(--text); background: rgba(255,255,255,.06); }
.plugins-backdrop { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: rgba(4,5,9,.55); backdrop-filter: blur(10px); }
.plugins-morph { width: min(560px, 100%); }
.plugins-panel { position: relative; padding: 26px; }
.plugins-close { position: absolute; top: -34px; right: 0; border: 0; background: transparent; color: var(--text-dim); }
.plugins-step { display: grid; gap: 14px; }
.plugins-step h2 { margin: 0; font-size: 18px; letter-spacing: -.02em; }
.plugins-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.plugins-list li { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 14px; background: rgba(255,255,255,.04); }
.plugins-name { font-size: 14px; }
.plugins-meta, .plugins-note { color: var(--text-dim); font-size: 12px; }
.plugins-hash { grid-column: 1 / -1; color: var(--text-faint); font-size: 11px; }
.plugins-held { grid-column: 1 / -1; display: grid; gap: 8px; padding-top: 8px; border-top: 1px solid var(--border); font-size: 12px; }
.plugins-hosts { display: grid; gap: 4px; margin: 0; padding-left: 18px; color: var(--text); font-size: 13px; }
.plugins-drop { min-height: 140px; padding: 20px; border: 1px dashed var(--border); border-radius: 18px; background: transparent; color: var(--text-dim); font-size: 13px; }
.plugins-url { display: grid; gap: 6px; font-size: 12px; color: var(--text-dim); }
.plugins-url input { padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: rgba(255,255,255,.03); color: var(--text); font-size: 13px; }
.plugins-actions { display: flex; gap: 10px; }
@media (max-width: 620px) { .plugins-morph { width: 100%; } .plugins-panel { padding: 18px; } }
```

- [ ] **Step 7: Run the suite and commit**

Run: `cd web && npm run test && npx tsc -b && npm run lint`
Expected: verde.

```bash
git add web/src/plugins/PluginsPanel.tsx web/src/plugins/PluginsPanel.test.tsx web/src/pages/Home.tsx \
  web/src/catalog/CatalogOverlay.tsx web/src/theme.css web/src/i18n/pt-BR.ts web/src/i18n/en.ts
git commit -m "feat: install and manage plugins from the header"
```

---

### Task 11: Atualização automática na abertura

**Files:**
- Modify: `web/src/main.tsx`

**Interfaces:**
- Consumes: `updateAll` (Task 7).
- Produces: nada novo.

Esta task não tem teste automatizado, e dizer isso é mais honesto do que acrescentar um que passaria de qualquer jeito. O comportamento de `updateAll` já é coberto na Task 7, onde ele é escrito; o que muda aqui é uma linha de `main.tsx`, e testá-la exigiria montar o boot do aplicativo inteiro para observar um efeito colateral que não retorna nada.

- [ ] **Step 1: Kick it off at boot**

Em `web/src/main.tsx`, depois do `createRoot(...).render(...)`:

```tsx
// Plugins check their origin once per load. It is deliberately not awaited:
// an update is never the reason the catalog takes longer to appear.
void import('./plugins/update').then(({ updateAll }) => updateAll()).catch(() => undefined)
```

- [ ] **Step 2: Verify by hand**

Rode `cd web && npm run dev`, instale um plugin de repositório, empurre um commit novo nesse repositório e recarregue a página. A versão na lista deve trocar sozinha.

Depois confirme o caso que importa mais: com o navegador offline, recarregue e veja que o plugin continua na versão instalada e nada aparece na tela. Uma falha de rede não é um evento.

- [ ] **Step 3: Type-check and commit**

Run: `cd web && npx tsc -b`

```bash
git add web/src/main.tsx
git commit -m "feat: check plugin origins once per load"
```

---

### Task 12: Guarda de SSRF em Go

**Files:**
- Create: `internal/urlingest/guard.go`
- Test: `internal/urlingest/guard_test.go`

**Interfaces:**
- Consumes: nada.
- Produces: `CheckURL(raw string) (*url.URL, error)`, `CheckAddr(network, addr string) error`, `ErrScheme`, `ErrPrivateAddress`, `ErrBadURL`, e `SafeClient(timeout time.Duration) *http.Client` — um cliente cujo dialer recusa endereço privado a cada salto.

- [ ] **Step 1: Write the failing test**

```go
// internal/urlingest/guard_test.go
package urlingest

import (
	"errors"
	"testing"
)

func TestCheckURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want error
	}{
		{"https public host", "https://cdn.example.com/movie.mkv", nil},
		{"http refused", "http://cdn.example.com/movie.mkv", ErrScheme},
		{"file refused", "file:///etc/passwd", ErrScheme},
		{"not a url", "://nope", ErrBadURL},
		{"empty host", "https:///movie.mkv", ErrBadURL},
		{"loopback name", "https://localhost/movie.mkv", ErrPrivateAddress},
		{"loopback v4", "https://127.0.0.1/movie.mkv", ErrPrivateAddress},
		{"loopback v6", "https://[::1]/movie.mkv", ErrPrivateAddress},
		{"rfc1918 ten", "https://10.0.0.5/movie.mkv", ErrPrivateAddress},
		{"rfc1918 172", "https://172.16.3.4/movie.mkv", ErrPrivateAddress},
		{"rfc1918 192", "https://192.168.1.9/movie.mkv", ErrPrivateAddress},
		{"link local", "https://169.254.169.254/latest/meta-data", ErrPrivateAddress},
		{"unique local v6", "https://[fd00::1]/movie.mkv", ErrPrivateAddress},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := CheckURL(test.raw)
			if !errors.Is(err, test.want) {
				t.Fatalf("CheckURL(%q) = %v, want %v", test.raw, err, test.want)
			}
		})
	}
}

func TestCheckAddr(t *testing.T) {
	if err := CheckAddr("tcp4", "93.184.216.34:443"); err != nil {
		t.Fatalf("public address refused: %v", err)
	}
	for _, addr := range []string{
		"127.0.0.1:443", "10.1.2.3:443", "169.254.169.254:80", "[::1]:443",
		"100.100.1.1:443", "198.18.0.1:443", "255.255.255.255:443", "[64:ff9b::a00:1]:443",
	} {
		if err := CheckAddr("tcp", addr); !errors.Is(err, ErrPrivateAddress) {
			t.Fatalf("CheckAddr(%q) = %v, want ErrPrivateAddress", addr, err)
		}
	}
}

// The test that matters, and the one a guard in the wrong place passes by
// accident: a perfectly ordinary hostname, resolved by the client itself, that
// lands on a private address. `localhost` is the one name every machine has.
func TestSafeClientRefusesANameThatResolvesToLoopback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	_, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatalf("split test server address: %v", err)
	}
	// http, not https: CheckURL is not what is under test here, the dialer is.
	request, err := http.NewRequest(http.MethodGet, "http://localhost:"+port+"/", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	if _, err := SafeClient(5 * time.Second).Do(request); err == nil {
		t.Fatal("expected the dial to be refused")
	} else if !strings.Contains(err.Error(), ErrPrivateAddress.Error()) {
		t.Fatalf("err = %v, want it to mention %v", err, ErrPrivateAddress)
	}
}

// And the other half: a name that resolves somewhere public is dialled.
// Without this, a guard that refuses everything would pass the test above.
func TestSafeClientAllowsAPublicAddress(t *testing.T) {
	if err := CheckAddr("tcp4", "93.184.216.34:443"); err != nil {
		t.Fatalf("public address refused by the dialer's gate: %v", err)
	}
}
```

Os imports do teste são `errors`, `net`, `net/http`, `net/http/httptest`, `strings`, `testing` e `time`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/urlingest/`
Expected: FAIL — pacote não existe.

- [ ] **Step 3: Write minimal implementation**

```go
// internal/urlingest/guard.go

// Package urlingest pulls a room's media from a URL a plugin produced.
//
// The server fetching an address chosen by third-party code is SSRF by
// construction, so the address is checked twice: once as a URL, and again as
// a resolved IP at connect time — which is the only check a DNS answer that
// changes between the two cannot slip past.
package urlingest

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"time"
)

var (
	ErrBadURL         = errors.New("source url is not a url")
	ErrScheme         = errors.New("source url must be https")
	ErrPrivateAddress = errors.New("source url resolves to a private address")
)

// CheckURL validates the address itself. It cannot see where a name resolves;
// CheckAddr does that, at the moment the connection is made.
func CheckURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadURL, err)
	}
	if parsed.Scheme != "https" {
		return nil, ErrScheme
	}
	if parsed.Host == "" || parsed.Hostname() == "" {
		return nil, ErrBadURL
	}
	host := parsed.Hostname()
	if host == "localhost" || hasSuffixFold(host, ".localhost") {
		return nil, ErrPrivateAddress
	}
	if ip := net.ParseIP(host); ip != nil && !isPublic(ip) {
		return nil, ErrPrivateAddress
	}
	return parsed, nil
}

// CheckAddr is the dialer's gate: every hop of every redirect passes here
// with an address already resolved.
func CheckAddr(_ string, addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrBadURL, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !isPublic(ip) {
		return ErrPrivateAddress
	}
	return nil
}

// blocked holds the ranges the standard library has no predicate for.
var blocked = func() []*net.IPNet {
	ranges := []string{
		"100.64.0.0/10",  // CGNAT — a carrier's inside, not the public internet
		"192.0.0.0/24",   // IETF protocol assignments
		"198.18.0.0/15",  // benchmarking
		"192.0.2.0/24",   // documentation
		"198.51.100.0/24",
		"203.0.113.0/24",
		"64:ff9b::/96",   // NAT64 — embeds an IPv4 address, private ones included
		"64:ff9b:1::/48", // local-use NAT64
		"2002::/16",      // 6to4, same problem
	}
	nets := make([]*net.IPNet, 0, len(ranges))
	for _, entry := range ranges {
		_, network, err := net.ParseCIDR(entry)
		if err != nil {
			panic("urlingest: bad blocked range " + entry)
		}
		nets = append(nets, network)
	}
	return nets
}()

func isPublic(ip net.IP) bool {
	// Everything that is not global unicast — loopback, link-local,
	// multicast, unspecified — is out in one predicate.
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	if ip4 := ip.To4(); ip4 != nil && ip4[0] == 255 {
		return false
	}
	for _, network := range blocked {
		if network.Contains(ip) {
			return false
		}
	}
	return true
}

func hasSuffixFold(value, suffix string) bool {
	if len(value) < len(suffix) {
		return false
	}
	return equalFold(value[len(value)-len(suffix):], suffix)
}

func equalFold(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if 'A' <= x && x <= 'Z' {
			x += 'a' - 'A'
		}
		if 'A' <= y && y <= 'Z' {
			y += 'a' - 'A'
		}
		if x != y {
			return false
		}
	}
	return true
}

// MaxRedirects bounds a chain that would otherwise be a way to spend the
// server's time for free.
const MaxRedirects = 5

// ResponseHeaderTimeout bounds how long an origin may take to say anything.
// There is deliberately no ceiling on reading the body: a 10 GB film is a
// long, legitimate read, and http.Client.Timeout would kill it.
const ResponseHeaderTimeout = 30 * time.Second

// SafeClient builds the only client this package fetches with.
//
// The address check lives in Dialer.Control, not in Transport.DialContext,
// and the difference is the whole thing. DialContext receives "host:port"
// with the name unresolved — net.ParseIP on it returns nil for every real
// hostname, so a check there either refuses every legitimate URL or checks
// nothing at all. Control runs once per connection, after the resolver and
// before connect, with the actual IP. It also closes the window between
// checking a name and connecting to it, which is what DNS rebinding lives in.
func SafeClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
		Control: func(network, address string, _ syscall.RawConn) error {
			return CheckAddr(network, address)
		},
	}
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= MaxRedirects {
				return fmt.Errorf("too many redirects")
			}
			_, err := CheckURL(req.URL.String())
			return err
		},
		Transport: &http.Transport{
			DialContext:           dialer.DialContext,
			ForceAttemptHTTP2:     true,
			ResponseHeaderTimeout: ResponseHeaderTimeout,
		},
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/urlingest/ -v`
Expected: PASS, todos os subtestes.

- [ ] **Step 5: Commit**

```bash
git add internal/urlingest/guard.go internal/urlingest/guard_test.go
git commit -m "feat: refuse private addresses when fetching a plugin url"
```

---

### Task 13: Ingestão por URL e a rota que a dispara

**Files:**
- Create: `internal/urlingest/ingest.go`
- Test: `internal/urlingest/ingest_test.go`
- Create: `internal/httpapi/urlsource.go`
- Test: `internal/httpapi/urlsource_test.go`
- Modify: `internal/httpapi/server.go` (registrar a rota junto de `RegisterTorrentRoute`)

**Interfaces:**
- Consumes: `CheckURL`/`SafeClient` (Task 12), o mesmo `room.Store` e o mesmo protocolo tus que `internal/torrent/ingest.go` usa.
- Produces:
  - `type Job struct { RoomID, URL, FileName string; Size int64 }`
  - `func NewIngestor(uploadURL string, maxJobs int, maxBytes int64, hooks Hooks) *Ingestor` com `Enabled()`, `Start(ctx)`, `Submit(Job) error`, `Cancel(roomID string)` e `ErrBusy` — mesma superfície de `torrent.Ingestor`, para que a rota fique idêntica em forma.
  - `func RegisterURLSourceRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config, ingestor URLIngestor)`

- [ ] **Step 1: Read the reference implementation completely**

Leia `internal/torrent/ingest.go` inteiro antes de escrever uma linha, com atenção a `run`, `pump`, `createUpload` e `uploadOffset`. A ingestão por URL é a mesma máquina com outra fonte de bytes: onde o torrent lê do bridge, esta faz um `GET` com `Range`. Leia também `internal/httpapi/torrent.go` inteiro — a rota nova é a mesma validação, a mesma guarda de estado da sala e as mesmas respostas.

- [ ] **Step 2: Write the failing test for the ingestor**

```go
// internal/urlingest/ingest_test.go
package urlingest

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// A tus endpoint just complete enough to be pumped into.
func fakeTus(t *testing.T, received *strings.Builder, mu *sync.Mutex) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.Header().Set("Location", "/uploads/1")
			w.WriteHeader(http.StatusCreated)
		case http.MethodHead:
			mu.Lock()
			defer mu.Unlock()
			w.Header().Set("Upload-Offset", strconv.Itoa(received.Len()))
			w.WriteHeader(http.StatusOK)
		case http.MethodPatch:
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			received.Write(body)
			w.Header().Set("Upload-Offset", strconv.Itoa(received.Len()))
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
		}
	}))
}

func TestIngestPumpsTheWholeBody(t *testing.T) {
	payload := strings.Repeat("video-bytes", 512)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "video/x-matroska")
		_, _ = io.WriteString(w, payload)
	}))
	defer source.Close()

	var received strings.Builder
	var mu sync.Mutex
	tus := fakeTus(t, &received, &mu)
	defer tus.Close()

	done := make(chan error, 1)
	ingestor := NewIngestor(tus.URL+"/uploads", 1, 1<<30, Hooks{OnFailed: func(_ string, err error) { done <- err }, OnDone: func(string) { done <- nil }})
	// The guard refuses httptest's loopback address, so the test injects a
	// client without it. The guard has its own tests; this one is about the pump.
	ingestor.client = &http.Client{Timeout: 10 * time.Second}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ingestor.Start(ctx)

	if err := ingestor.Submit(Job{RoomID: "r1", URL: source.URL + "/movie.mkv", FileName: "movie.mkv", Size: int64(len(payload))}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("ingest failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ingest did not finish")
	}
	mu.Lock()
	defer mu.Unlock()
	if received.String() != payload {
		t.Fatalf("received %d bytes, want %d", received.Len(), len(payload))
	}
}

// The common case: a stream carries a url and no byte count.
func TestIngestAsksTheOriginWhenTheSizeIsUnknown(t *testing.T) {
	payload := strings.Repeat("video-bytes", 512)
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/x-matroska")
		if r.Header.Get("Range") == "bytes=0-0" {
			w.Header().Set("Content-Range", "bytes 0-0/"+strconv.Itoa(len(payload)))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, payload[:1])
			return
		}
		_, _ = io.WriteString(w, payload)
	}))
	defer source.Close()

	var received strings.Builder
	var mu sync.Mutex
	tus := fakeTus(t, &received, &mu)
	defer tus.Close()

	done := make(chan error, 1)
	ingestor := NewIngestor(tus.URL+"/uploads", 1, 1<<30, Hooks{
		OnFailed: func(_ string, err error) { done <- err },
		OnDone:   func(string) { done <- nil },
	})
	ingestor.client = &http.Client{Timeout: 10 * time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ingestor.Start(ctx)

	if err := ingestor.Submit(Job{RoomID: "r2", URL: source.URL + "/movie.mkv", FileName: "movie.mkv"}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("ingest failed: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ingest did not finish")
	}
	mu.Lock()
	defer mu.Unlock()
	if received.Len() != len(payload) {
		t.Fatalf("received %d bytes, want %d", received.Len(), len(payload))
	}
}

func TestIngestRefusesAnHTMLErrorPage(t *testing.T) {
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, "<html>not here</html>")
	}))
	defer source.Close()

	var received strings.Builder
	var mu sync.Mutex
	tus := fakeTus(t, &received, &mu)
	defer tus.Close()

	done := make(chan error, 1)
	ingestor := NewIngestor(tus.URL+"/uploads", 1, 1<<30, Hooks{
		OnFailed: func(_ string, err error) { done <- err },
		OnDone:   func(string) { done <- nil },
	})
	ingestor.client = &http.Client{Timeout: 10 * time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ingestor.Start(ctx)

	if err := ingestor.Submit(Job{RoomID: "r3", URL: source.URL + "/movie.mkv", FileName: "movie.mkv", Size: 21}); err != nil {
		t.Fatalf("submit: %v", err)
	}
	select {
	case err := <-done:
		if !errors.Is(err, ErrNotVideo) {
			t.Fatalf("err = %v, want ErrNotVideo", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("ingest did not finish")
	}
	mu.Lock()
	defer mu.Unlock()
	if received.Len() != 0 {
		t.Fatalf("wrote %d bytes of an html page into the room", received.Len())
	}
}

func TestIngestRefusesAPrivateURL(t *testing.T) {
	ingestor := NewIngestor("http://example.invalid/uploads", 1, 1<<30, Hooks{})
	if err := ingestor.Submit(Job{RoomID: "r1", URL: "http://127.0.0.1/movie.mkv", FileName: "m.mkv", Size: 10}); err == nil {
		t.Fatal("expected a private url to be refused at submit")
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/urlingest/`
Expected: FAIL — `NewIngestor`, `Job` e `Hooks` não existem.

- [ ] **Step 4: Write the ingestor**

Este é `internal/torrent/ingest.go` com outra fonte de bytes. O que muda em relação ao arquivo de referência, e por quê:

- O `client` sai de `SafeClient(0)` e é um campo substituível, porque `httptest` serve em loopback e a guarda recusa loopback. A guarda tem os testes dela na Task 12; este teste é sobre a bomba.
- Um `Content-Type` que não seja de vídeo derruba o job. Seguir um redirect até uma página de erro em HTML e gravá-la como se fosse um filme é pior do que falhar.
- Um `Content-Length` que estoure `Job.Size` derruba o job antes de qualquer byte ser gravado: o tamanho anunciado é o que a sala reservou no tus, e um upload com o comprimento errado nunca completa.
- Um `200` quando pedimos `Range` a partir de um offset maior que zero derruba o job. O servidor está mandando o arquivo do começo; aceitar isso grava bytes duplicados no meio do arquivo.
- Não há métricas. As do torrent são específicas dele (`TorrentPeers`, `TorrentIngests`), e inventar um espelho delas aqui é escopo que ninguém pediu — `slog` cobre o que precisa ser visto.
- `Hooks` ganha `OnDone`, porque o teste precisa de um sinal de sucesso e a sala não tem outro.

```go
// internal/urlingest/ingest.go
package urlingest

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// resumeAttempts bounds how many times a broken stream is picked up again
	// without a single byte being stored. A slow origin stalls rather than
	// fails, so only a run that makes no progress counts against this.
	resumeAttempts = 5
	// resumeBackoff spaces out those retries.
	resumeBackoff = 3 * time.Second
	// tusVersion is the only protocol version the server speaks.
	tusVersion = "1.0.0"
)

// Job is one remote file to pull into one room.
type Job struct {
	RoomID   string
	URL      string
	FileName string
	// Size is what the caller announced. Zero means unknown, which is the
	// common case: a stream object carries a URL far more often than it
	// carries a byte count. An unknown size is asked of the origin instead.
	Size int64
}

// Hooks lets the ingest report into the rest of the server without depending
// on it. Both are optional.
type Hooks struct {
	// OnFailed reports an ingest that gave up, so the room can stop showing a
	// transfer that is not happening.
	OnFailed func(roomID string, err error)
	// OnDone reports one that finished.
	OnDone func(roomID string)
}

var (
	// ErrBusy reports that too many ingests are already running.
	ErrBusy = errors.New("too many url ingests in flight")
	// ErrNotVideo reports a source that answered with something other than a
	// video — an HTML error page, most likely.
	ErrNotVideo = errors.New("source did not return a video")
	// ErrTooLarge reports a source bigger than the size the room reserved.
	ErrTooLarge = errors.New("source is larger than the announced size")
	// ErrNoRange reports a source that ignored a Range request, which makes a
	// resumed transfer impossible.
	ErrNoRange = errors.New("source does not support resuming")
	// ErrUnknownSize reports a source that will not say how big it is. A tus
	// upload is created against a length, so there is nothing to create.
	ErrUnknownSize = errors.New("source did not report its size")
)

// Ingestor pulls remote files into rooms through the server's own tus
// endpoint, for the same reason the torrent ingestor does: the upload
// reservation, the progress ticks that start the preview, the completion
// hand-off and the sweeper all already exist on that path.
type Ingestor struct {
	uploadURL string
	client    *http.Client
	hooks     Hooks
	// maxBytes is the room's ceiling, the same one the manual upload has. It
	// is enforced here because a job with an unknown size cannot be checked
	// by the route.
	maxBytes int64

	// backoff spaces out resumed streams. A field rather than a constant so
	// tests can exercise the stall path without waiting out real seconds.
	backoff time.Duration

	mu      sync.Mutex
	ctx     context.Context
	started bool
	running map[string]context.CancelFunc
	maxJobs int
}

// NewIngestor wires an ingestor to the tus endpoint of this same server.
// uploadURL is absolute and loopback.
func NewIngestor(uploadURL string, maxJobs int, maxBytes int64, hooks Hooks) *Ingestor {
	if maxJobs < 1 {
		maxJobs = 1
	}
	return &Ingestor{
		uploadURL: uploadURL,
		client:    SafeClient(0),
		hooks:     hooks,
		maxBytes:  maxBytes,
		backoff:   resumeBackoff,
		running:   make(map[string]context.CancelFunc),
		maxJobs:   maxJobs,
	}
}

// Enabled reports whether url sources can be ingested at all.
func (i *Ingestor) Enabled() bool { return i != nil && i.uploadURL != "" }

// Start makes the ingestor accept jobs until ctx is cancelled.
func (i *Ingestor) Start(ctx context.Context) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.ctx = ctx
	i.started = true
}

// Submit starts pulling job in the background. One room can only have one
// ingest, and starting a new one replaces whatever was running for it.
//
// The url is checked here rather than in the goroutine so that a caller who
// hands over a private address learns about it in the response.
func (i *Ingestor) Submit(job Job) error {
	if _, err := CheckURL(job.URL); err != nil {
		return err
	}
	if job.Size < 0 || (i.maxBytes > 0 && job.Size > i.maxBytes) {
		return fmt.Errorf("%w: announced size %d", ErrTooLarge, job.Size)
	}
	i.mu.Lock()
	if !i.started || i.ctx == nil || i.ctx.Err() != nil {
		i.mu.Unlock()
		return errors.New("ingestor not running")
	}
	if _, exists := i.running[job.RoomID]; !exists && len(i.running) >= i.maxJobs {
		i.mu.Unlock()
		return ErrBusy
	}
	if cancel, exists := i.running[job.RoomID]; exists {
		cancel()
	}
	jobCtx, cancel := context.WithCancel(i.ctx)
	i.running[job.RoomID] = cancel
	i.mu.Unlock()

	go func() {
		defer i.finish(job.RoomID)
		err := i.run(jobCtx, job)
		if err == nil {
			slog.Info("url ingest complete", "room_id", job.RoomID, "bytes", job.Size)
			if i.hooks.OnDone != nil {
				i.hooks.OnDone(job.RoomID)
			}
			return
		}
		if jobCtx.Err() != nil {
			slog.Info("url ingest stopped", "room_id", job.RoomID)
			return
		}
		slog.Error("url ingest failed", "room_id", job.RoomID, "error", err)
		if i.hooks.OnFailed != nil {
			i.hooks.OnFailed(job.RoomID, err)
		}
	}()
	return nil
}

// Cancel stops the ingest feeding roomID, if any. Swapping a room's source
// calls it before the previous media is deleted.
func (i *Ingestor) Cancel(roomID string) {
	i.mu.Lock()
	cancel, ok := i.running[roomID]
	i.mu.Unlock()
	if ok {
		cancel()
	}
}

func (i *Ingestor) finish(roomID string) {
	i.mu.Lock()
	delete(i.running, roomID)
	i.mu.Unlock()
}

func (i *Ingestor) run(ctx context.Context, job Job) error {
	if job.Size <= 0 {
		// tus creates an upload against a length, so the length has to come
		// from somewhere. Ask the origin before anything is reserved.
		size, err := i.probeSize(ctx, job)
		if err != nil {
			return err
		}
		job.Size = size
	}
	if i.maxBytes > 0 && job.Size > i.maxBytes {
		return fmt.Errorf("%w: %d bytes, ceiling is %d", ErrTooLarge, job.Size, i.maxBytes)
	}
	uploadURL, err := i.createUpload(ctx, job)
	if err != nil {
		return err
	}
	slog.Info("url ingest started", "room_id", job.RoomID, "bytes", job.Size)

	offset := int64(0)
	for attempt := 0; offset < job.Size; {
		written, err := i.pump(ctx, job, uploadURL, offset)
		offset += written
		if offset >= job.Size {
			break
		}
		// A source that hands back something other than a video, or more bytes
		// than the room reserved, will do it again on every retry.
		if errors.Is(err, ErrNotVideo) || errors.Is(err, ErrTooLarge) || errors.Is(err, ErrNoRange) || errors.Is(err, ErrUnknownSize) {
			return err
		}
		if err == nil {
			// A body that ended early without an error still leaves bytes to
			// fetch; a fresh request picks up where the store did.
			err = io.ErrUnexpectedEOF
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if written > 0 {
			// Progress was made, so this is a hiccup rather than a broken
			// pipeline: keep going without spending an attempt.
			attempt = 0
		} else {
			attempt++
			if attempt >= resumeAttempts {
				return fmt.Errorf("url ingest stalled at %d/%d bytes: %w", offset, job.Size, err)
			}
		}
		slog.Warn("url ingest resuming",
			"room_id", job.RoomID, "offset", offset, "attempt", attempt, "error", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(i.backoff):
		}
	}
	return nil
}

// probeSize asks the origin how big the file is, with a one-byte range
// request. A HEAD would be tidier and is answered wrongly by enough origins
// that it is not worth the tidiness.
func (i *Ingestor) probeSize(ctx context.Context, job Job) (int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, job.URL, nil)
	if err != nil {
		return 0, fmt.Errorf("build probe request: %w", err)
	}
	request.Header.Set("Range", "bytes=0-0")
	response, err := i.client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("probe source: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
	}()
	if contentType := response.Header.Get("Content-Type"); contentType != "" && !videoContentType(contentType) {
		return 0, fmt.Errorf("%w: content-type %q", ErrNotVideo, contentType)
	}
	if response.StatusCode == http.StatusPartialContent {
		// "bytes 0-0/12345" — the total is what is after the slash.
		contentRange := response.Header.Get("Content-Range")
		if slash := strings.LastIndexByte(contentRange, '/'); slash >= 0 {
			if total, err := strconv.ParseInt(strings.TrimSpace(contentRange[slash+1:]), 10, 64); err == nil && total > 0 {
				return total, nil
			}
		}
	}
	if response.StatusCode == http.StatusOK && response.ContentLength > 0 {
		return response.ContentLength, nil
	}
	return 0, ErrUnknownSize
}

// fetch opens the source at offset and returns a body that stops at the
// announced size.
func (i *Ingestor) fetch(ctx context.Context, job Job, offset int64) (io.ReadCloser, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, job.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("build source request: %w", err)
	}
	if offset > 0 {
		request.Header.Set("Range", "bytes="+strconv.FormatInt(offset, 10)+"-")
	}
	response, err := i.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("fetch source: %w", err)
	}
	discard := func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		discard()
		return nil, fmt.Errorf("source answered %d", response.StatusCode)
	}
	if offset > 0 && response.StatusCode == http.StatusOK {
		// The origin ignored the Range and is sending the file from the start.
		// Writing that at this offset would corrupt the file silently.
		discard()
		return nil, ErrNoRange
	}
	if contentType := response.Header.Get("Content-Type"); contentType != "" && !videoContentType(contentType) {
		discard()
		return nil, fmt.Errorf("%w: content-type %q", ErrNotVideo, contentType)
	}
	if response.ContentLength >= 0 && offset+response.ContentLength > job.Size {
		discard()
		return nil, fmt.Errorf("%w: %d bytes from offset %d, room reserved %d",
			ErrTooLarge, response.ContentLength, offset, job.Size)
	}
	// The limit is the belt to the Content-Length braces above: a chunked
	// response announces nothing, and the store must not receive more than the
	// upload was created for.
	return readCloser{Reader: io.LimitReader(response.Body, job.Size-offset), Closer: response.Body}, nil
}

type readCloser struct {
	io.Reader
	io.Closer
}

// videoContentType accepts what a media file is actually served as. Some
// origins hand back application/octet-stream for an .mkv, which is not wrong.
func videoContentType(value string) bool {
	media := strings.TrimSpace(strings.ToLower(value))
	if index := strings.IndexByte(media, ';'); index >= 0 {
		media = strings.TrimSpace(media[:index])
	}
	return strings.HasPrefix(media, "video/") || media == "application/octet-stream" ||
		media == "application/mp4" || media == "application/x-matroska"
}

// pump moves one stream of source bytes into one tus PATCH and reports how
// many bytes the server confirmed it stored.
func (i *Ingestor) pump(ctx context.Context, job Job, uploadURL string, offset int64) (int64, error) {
	body, err := i.fetch(ctx, job, offset)
	if err != nil {
		return 0, err
	}
	defer body.Close()

	request, err := http.NewRequestWithContext(ctx, http.MethodPatch, uploadURL, body)
	if err != nil {
		return 0, fmt.Errorf("build upload request: %w", err)
	}
	request.Header.Set("Tus-Resumable", tusVersion)
	request.Header.Set("Content-Type", "application/offset+octet-stream")
	request.Header.Set("Upload-Offset", strconv.FormatInt(offset, 10))
	// Declaring the length keeps the request out of chunked encoding and lets
	// the store detect a truncated stream instead of accepting it as the end.
	request.ContentLength = job.Size - offset

	response, err := i.client.Do(request)
	if err != nil {
		// The bytes the server did store are still there; ask it how far it got.
		stored, headErr := i.uploadOffset(ctx, uploadURL)
		if headErr != nil {
			return 0, errors.Join(fmt.Errorf("upload source bytes: %w", err), headErr)
		}
		return stored - offset, fmt.Errorf("upload source bytes: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1<<16))
		response.Body.Close()
	}()
	if response.StatusCode != http.StatusNoContent {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 1<<10))
		stored, headErr := i.uploadOffset(ctx, uploadURL)
		if headErr != nil {
			stored = offset
		}
		return stored - offset, fmt.Errorf("upload rejected (%d): %s",
			response.StatusCode, strings.TrimSpace(string(detail)))
	}
	next, err := strconv.ParseInt(response.Header.Get("Upload-Offset"), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("upload returned no offset: %w", err)
	}
	return next - offset, nil
}

func (i *Ingestor) createUpload(ctx context.Context, job Job) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, i.uploadURL, nil)
	if err != nil {
		return "", fmt.Errorf("build upload creation: %w", err)
	}
	request.Header.Set("Tus-Resumable", tusVersion)
	request.Header.Set("Upload-Length", strconv.FormatInt(job.Size, 10))
	request.Header.Set("Upload-Metadata", encodeMetadata(map[string]string{
		"roomID":   job.RoomID,
		"filename": job.FileName,
	}))
	response, err := i.client.Do(request)
	if err != nil {
		return "", fmt.Errorf("create upload: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 1<<10))
		return "", fmt.Errorf("create upload failed (%d): %s",
			response.StatusCode, strings.TrimSpace(string(detail)))
	}
	location := response.Header.Get("Location")
	if location == "" {
		return "", errors.New("create upload returned no location")
	}
	return resolveLocation(i.uploadURL, location), nil
}

func (i *Ingestor) uploadOffset(ctx context.Context, uploadURL string) (int64, error) {
	// The parent context may already be cancelled by the very failure that
	// brought us here, and the answer is still needed to resume later.
	headCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(headCtx, http.MethodHead, uploadURL, nil)
	if err != nil {
		return 0, fmt.Errorf("build offset request: %w", err)
	}
	request.Header.Set("Tus-Resumable", tusVersion)
	response, err := i.client.Do(request)
	if err != nil {
		return 0, fmt.Errorf("read upload offset: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("read upload offset failed (%d)", response.StatusCode)
	}
	offset, err := strconv.ParseInt(response.Header.Get("Upload-Offset"), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse upload offset: %w", err)
	}
	return offset, nil
}

// encodeMetadata and resolveLocation are the tus helpers, copied rather than
// exported from internal/torrent: they are six lines each, and making that
// package export them to this one couples two ingests that have nothing else
// in common.
func encodeMetadata(values map[string]string) string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(keys))
	for _, key := range keys {
		pairs = append(pairs, key+" "+base64.StdEncoding.EncodeToString([]byte(values[key])))
	}
	return strings.Join(pairs, ",")
}

func resolveLocation(endpoint, location string) string {
	base, err := url.Parse(endpoint)
	if err != nil {
		return location
	}
	resolved, err := base.Parse(location)
	if err != nil {
		return location
	}
	return resolved.String()
}
```

`SafeClient(0)` é deliberado. Um `http.Client.Timeout` cobre a leitura inteira do corpo, e um filme de duas horas é uma leitura longa e legítima — um teto ali mataria transferências boas. O timeout que protege é o do dial, e o `net.Dialer` da Task 12 já o tem.

- [ ] **Step 5: Write the failing test for the route**

Os helpers `newTestStore`, `testCfg` e `newUploadingRoom` já existem no pacote — `newUploadingRoom` está em `internal/httpapi/torrent_test.go:43`. Este arquivo os reusa; não escreva outros.

```go
// internal/httpapi/urlsource_test.go
package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/urlingest"
)

type fakeURLIngestor struct {
	enabled bool
	jobs    []urlingest.Job
	err     error
}

func (f *fakeURLIngestor) Enabled() bool { return f.enabled }

func (f *fakeURLIngestor) Submit(job urlingest.Job) error {
	if f.err != nil {
		return f.err
	}
	f.jobs = append(f.jobs, job)
	return nil
}

func urlEngine(t *testing.T, ingestor URLIngestor) (*gin.Engine, *room.Store) {
	t.Helper()
	s := newTestStore(t)
	e := gin.New()
	RegisterURLSourceRoute(e.Group("/api"), s, testCfg(t), ingestor)
	return e, s
}

func postURL(t *testing.T, e *gin.Engine, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/rooms/"+id+"/url", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	e.ServeHTTP(w, req)
	return w
}

const validURLBody = `{"url":"https://cdn.example.com/movie.mkv","fileName":"movie.mkv","size":1048576}`

func TestIngestURLHandsTheSourceToTheServer(t *testing.T) {
	ingestor := &fakeURLIngestor{enabled: true}
	e, s := urlEngine(t, ingestor)
	newUploadingRoom(t, s, "room-url-1")

	w := postURL(t, e, "room-url-1", validURLBody)

	require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	require.Len(t, ingestor.jobs, 1)
	require.Equal(t, "https://cdn.example.com/movie.mkv", ingestor.jobs[0].URL)
	require.Equal(t, "room-url-1", ingestor.jobs[0].RoomID)
	require.Equal(t, int64(1048576), ingestor.jobs[0].Size)
}

// The guard's own tests cover every shape of address; this one only proves the
// route asks it at all, and answers with the reason instead of a bare 400.
func TestIngestURLRefusesAnUnsafeSource(t *testing.T) {
	for name, body := range map[string]string{
		"plain http": `{"url":"http://cdn.example.com/m.mkv","fileName":"m.mkv","size":1024}`,
		"loopback":   `{"url":"https://127.0.0.1/m.mkv","fileName":"m.mkv","size":1024}`,
		"private":    `{"url":"https://192.168.1.9/m.mkv","fileName":"m.mkv","size":1024}`,
		"localhost":  `{"url":"https://localhost/m.mkv","fileName":"m.mkv","size":1024}`,
	} {
		t.Run(name, func(t *testing.T) {
			ingestor := &fakeURLIngestor{enabled: true}
			e, s := urlEngine(t, ingestor)
			newUploadingRoom(t, s, "room-url-2")

			w := postURL(t, e, "room-url-2", body)

			require.Equal(t, http.StatusBadRequest, w.Code)
			require.Empty(t, ingestor.jobs)
		})
	}
}

func TestIngestURLRouteAbsentWithoutAnIngestor(t *testing.T) {
	e, s := urlEngine(t, &fakeURLIngestor{enabled: false})
	newUploadingRoom(t, s, "room-url-3")

	require.Equal(t, http.StatusNotFound, postURL(t, e, "room-url-3", validURLBody).Code)
}

func TestIngestURLRejectsARoomNotWaitingForOne(t *testing.T) {
	e, s := urlEngine(t, &fakeURLIngestor{enabled: true})
	newUploadingRoom(t, s, "room-url-4")
	require.NoError(t, s.SetStatus(context.Background(), "room-url-4", "ready"))

	require.Equal(t, http.StatusForbidden, postURL(t, e, "room-url-4", validURLBody).Code)
}

func TestIngestURLReportsABusyIngest(t *testing.T) {
	e, s := urlEngine(t, &fakeURLIngestor{enabled: true, err: urlingest.ErrBusy})
	newUploadingRoom(t, s, "room-url-5")

	require.Equal(t, http.StatusServiceUnavailable, postURL(t, e, "room-url-5", validURLBody).Code)
}
```

`s.SetStatus` é o mesmo método que `internal/httpapi/torrent_test.go:95` usa para tirar a sala de `uploading`.

- [ ] **Step 6: Write the route**

```go
// internal/httpapi/urlsource.go
package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/giulianoo0/ss/internal/config"
	"github.com/giulianoo0/ss/internal/room"
	"github.com/giulianoo0/ss/internal/urlingest"
)

const maxURLBodyBytes = 4 << 10

// URLIngestor is the piece of the ingest the API needs: hand it a url and it
// pulls the bytes in on its own.
type URLIngestor interface {
	Enabled() bool
	Submit(job urlingest.Job) error
}

type ingestURLRequest struct {
	URL      string `json:"url" binding:"required"`
	FileName string `json:"fileName" binding:"required"`
	// No `binding:"required"` on Size: zero is a legitimate value meaning
	// "the stream did not say", and the ingestor asks the origin instead.
	// `required` on an int64 rejects zero, which would refuse the common case.
	Size int64 `json:"size"`
}

// RegisterURLSourceRoute mounts the endpoint that hands a plugin-supplied url
// to the server-side ingest.
//
// It is guarded exactly like the torrent route it sits next to, and for the
// same reason: this is a request for the server to perform the upload the
// browser would otherwise perform itself. What it adds is the address check —
// the url came from a plugin, so it is the least trusted input the server
// takes, and it is checked before the room is touched at all.
func RegisterURLSourceRoute(rg *gin.RouterGroup, store *room.Store, cfg config.Config, ingestor URLIngestor) {
	if ingestor == nil || !ingestor.Enabled() {
		return
	}
	rg.POST("/rooms/:id/url", ingestURL(store, cfg, ingestor))
}

func ingestURL(store *room.Store, cfg config.Config, ingestor URLIngestor) gin.HandlerFunc {
	return func(c *gin.Context) {
		roomID := c.Param("id")
		if !validMediaRoomID(roomID) {
			c.Status(http.StatusNotFound)
			return
		}

		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxURLBodyBytes)
		var req ingestURLRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		if !validFileName(req.FileName) || req.Size < 0 || req.Size > cfg.MaxUploadMB<<20 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		// The reason travels back because the person who has to act on it is
		// the one who installed the plugin: "not https" and "points at a
		// private address" are different problems with different fixes.
		if _, err := urlingest.CheckURL(req.URL); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "unsafe_source", "reason": err.Error()})
			return
		}

		storedRoom, err := store.Get(c.Request.Context(), roomID)
		if errors.Is(err, room.ErrNotFound) || err == nil && !storedRoom.ExpiresAt.After(time.Now()) {
			c.JSON(http.StatusNotFound, gin.H{"error": "room_not_found"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "load room for url ingest", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		if storedRoom.Status != "uploading" {
			c.JSON(http.StatusForbidden, gin.H{"error": "room is not accepting uploads"})
			return
		}
		uploadID, err := store.UploadID(c.Request.Context(), roomID)
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "read upload reservation", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		if uploadID != "" {
			c.JSON(http.StatusConflict, gin.H{"error": "room already has an upload"})
			return
		}

		// A zero here is honest: the room shows a transfer with no total until
		// the ingestor learns one from the origin.
		if err := store.SetIngestProgress(c.Request.Context(), roomID, 0, req.Size); err != nil {
			slog.ErrorContext(c.Request.Context(), "record ingest size", "room_id", roomID, "error", err)
		}
		if err := store.SetPreviewPhase(c.Request.Context(), roomID, room.PreviewReceiving, 0); err != nil {
			slog.ErrorContext(c.Request.Context(), "record preview phase", "room_id", roomID, "error", err)
		}

		err = ingestor.Submit(urlingest.Job{
			RoomID:   roomID,
			URL:      req.URL,
			FileName: req.FileName,
			Size:     req.Size,
		})
		if errors.Is(err, urlingest.ErrBusy) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "url ingest busy"})
			return
		}
		if err != nil {
			slog.ErrorContext(c.Request.Context(), "submit url ingest", "room_id", roomID, "error", err)
			c.Status(http.StatusInternalServerError)
			return
		}
		c.JSON(http.StatusAccepted, gin.H{"status": "uploading", "sourceBytes": req.Size})
	}
}
```

O `CheckURL` roda duas vezes: aqui e no `Submit` do ingestor. Isso é de propósito. A rota precisa dele para responder 400 com a razão; o ingestor precisa dele porque nada garante que a única porta de entrada dele seja esta rota.

Em `internal/httpapi/server.go`, registre ao lado da chamada de `RegisterTorrentRoute`, com o mesmo grupo e a mesma `cfg`:

```go
RegisterURLSourceRoute(api, store, cfg, urlIngestor)
```

O `urlIngestor` vem de onde o `torrent.Ingestor` já é construído e iniciado — encontre a chamada de `NewIngestor` do torrent no wiring (`cmd/` ou o construtor do servidor), construa `urlingest.NewIngestor(uploadURL, maxJobs, cfg.MaxUploadMB<<20, urlingest.Hooks{OnFailed: <o mesmo hook que o torrent usa para derrubar a transferência da sala>})` com o **mesmo** `uploadURL` de loopback, e chame `Start(ctx)` no mesmo lugar.

- [ ] **Step 7: Run everything and commit**

Run: `go test ./... && go vet ./...`
Expected: verde.

```bash
git add internal/urlingest internal/httpapi/urlsource.go internal/httpapi/urlsource_test.go internal/httpapi/server.go
git commit -m "feat: ingest a room's media from a plugin url"
```

---

### Task 14: Abrir uma fonte de URL pelo cliente

**Files:**
- Modify: `web/src/upload.ts`
- Test: `web/src/upload.test.ts`
- Modify: `web/src/pages/Home.tsx:197`
- Modify: `web/src/pages/Room.tsx:267`

**Interfaces:**
- Consumes: a rota da Task 13, `StreamLocation` (Task 8).
- Produces: `createRoomAndIngestUrl(url: string, fileName: string, size: number, nickname: string): Promise<UploadResult>` e `startUrlTransfer(roomID: string, url: string, fileName: string, size: number): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`web/src/upload.test.ts:1-2` já importa de `vitest` e de `./upload`. **Não acrescente imports**: some `startUrlTransfer` à lista da linha 2 e cole só o `describe`.

```ts
// acrescente a web/src/upload.test.ts
describe('startUrlTransfer', () => {
  it('hands the url to the room and lets the server pull it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }))
    vi.stubGlobal('fetch', fetchMock)
    await startUrlTransfer('room1', 'https://cdn.example.com/m.mkv', 'm.mkv', 1024)
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room1/url', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      url: 'https://cdn.example.com/m.mkv', fileName: 'm.mkv', size: 1024,
    })
    vi.unstubAllGlobals()
  })

  it('carries the reason the server gave, not just the status', async () => {
    // "not https" and "points at your own network" are different problems
    // with different fixes, and the person who has to act on it is the one
    // who installed the plugin.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('{"error":"unsafe_source","reason":"source url must be https"}', { status: 400 }),
    ))
    await expect(startUrlTransfer('room1', 'http://cdn.example.com/m.mkv', 'm.mkv', 1024))
      .rejects.toThrow(/must be https/)
    vi.unstubAllGlobals()
  })

  it('still says something useful when the body is not the shape it should be', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 })))
    await expect(startUrlTransfer('room1', 'https://cdn.example.com/m.mkv', 'm.mkv', 1024))
      .rejects.toThrow(/502/)
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/upload.test.ts`
Expected: FAIL — `startUrlTransfer` não existe.

- [ ] **Step 3: Write minimal implementation**

Em `web/src/upload.ts`, junto de `createRoomAndUploadTorrent`:

```ts
/**
 * Points a room at a URL and lets the server fetch it. The bytes never touch
 * this browser — the same trade the torrent handover makes, for the same
 * reason.
 */
export async function startUrlTransfer(roomID: string, url: string, fileName: string, size: number): Promise<void> {
  const response = await fetch(`/api/rooms/${encodeURIComponent(roomID)}/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, fileName, size }),
  })
  if (response.ok) return
  // The server names which rule barred the address; dropping that and
  // reporting a bare status would leave the host with nothing to act on.
  let reason = ''
  try {
    const body = await response.json() as { reason?: unknown }
    if (typeof body.reason === 'string') reason = body.reason
  } catch { /* not JSON, which is itself not worth reporting */ }
  throw new Error(reason ? `url source refused (${response.status}): ${reason}` : `url source refused (${response.status})`)
}

export async function createRoomAndIngestUrl(
  url: string,
  fileName: string,
  size: number,
  nickname: string,
): Promise<UploadResult> {
  if (mocksEnabled) return mockCreateRoom(nickname)
  const created = await createRoom(fileName, nickname)
  await startUrlTransfer(created.id, url, fileName, size)
  return { roomID: created.id, nickname: created.nickname }
}
```

- [ ] **Step 4: Branch at both call sites**

Em `web/src/pages/Home.tsx`, o ramo `media.kind === 'stream'` (linhas 190-210) vira dois. **Não saia cedo com `navigate`**: tudo o que vem depois do `if/else` — `setNickname`, gravar `ss.nickname`, escrever o histórico — vale para uma sala aberta por URL exatamente como vale para as outras, e um `return` ali faz a sala sumir do histórico e o apelido não ser salvo.

```tsx
      } else if (media.kind === 'stream' && media.pick.stream.location.kind === 'url') {
        // The details panel sits over the whole page; leaving it up would
        // hide the progress (and any error) that comes next.
        closeTitle()
        const { url } = media.pick.stream.location
        // A url source has no swarm to open and no file list to pick from.
        // The size is zero because a stream object rarely carries one, and
        // zero is how the server is told to ask the origin instead.
        room = await createRoomAndIngestUrl(url, `${media.pick.displayName}.mkv`, 0, draftNickname.trim())
        fileName = media.pick.displayName
        const playing = nowPlayingFromPick(media.pick)
        try {
          if (playing) localStorage.setItem(nowPlayingKey(room.roomID), JSON.stringify(playing))
        } catch { /* private mode */ }
      } else if (media.kind === 'stream') {
        // ... o corpo do ramo de torrent de hoje, sem alteração ...
      } else {
```

O apelido é `draftNickname.trim()`, que é o que o diálogo acabou de coletar — `nickname` é o estado anterior. E o campo de título é `displayName`: `TitlePick` (`web/src/catalog/MetaDetails.tsx:22-30`) tem `stream`, `target`, `displayName`, `metaName` e `poster`, e não tem `title`.

Em `web/src/pages/Room.tsx`, dentro de `chooseCatalogStream` (linha 267), ramifique antes de abrir o torrent:

```tsx
    void swapSource(async () => {
      if (pick.stream.location.kind === 'url') {
        const { url } = pick.stream.location
        await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', pick.displayName)
        await startUrlTransfer(room.id, url, `${pick.displayName}.mkv`, 0)
        return
      }
      const opened = await openCatalogStream(pick.stream)
      // ... o resto como está hoje ...
    })
```

Nenhum `mediaGeneration` aqui, e isso é deliberado. O caminho de torrent precisa dele porque é o navegador que faz o `PATCH` do tus e tem de dizer para qual geração está escrevendo. O caminho de URL entrega a fonte ao servidor, que cria o upload por conta própria — exatamente como a rota `/rooms/:id/torrent` já faz, e ela também não recebe geração nenhuma.

- [ ] **Step 5: Run the suite and commit**

Run: `cd web && npm run test && npx tsc -b && npm run lint`
Expected: verde, sem o `throw new Error('url sources arrive in task 12')` da Task 9 em lugar nenhum.

```bash
git add web/src/upload.ts web/src/upload.test.ts web/src/pages/Home.tsx web/src/pages/Room.tsx
git commit -m "feat: open a room from a plugin's direct url"
```

---

### Task 15: O plugin do Torrentio, em repositório próprio

**Files:**
- Create (fora deste repositório): `ss-plugin-torrentio/plugin.js`, `ss-plugin-torrentio/README.md`, `ss-plugin-torrentio/LICENSE`
- Modify: `README.md` deste repositório

**Interfaces:**
- Consumes: o contrato das Tasks 1 e 4.
- Produces: um repositório público instalável por URL.

- [ ] **Step 1: Write the plugin**

```js
// plugin.js
export const manifest = {
  id: 'torrentio',
  name: 'Torrentio',
  version: '1.0.0',
  hosts: ['torrentio.strem.fun'],
  updateUrl: 'https://github.com/<owner>/ss-plugin-torrentio',
}

// Torrentio speaks the Stremio stream protocol, and so does ss: the addon's
// answer is handed back untouched, and the parsing of release names, sizes
// and language flags happens on the other side, where it is tested.
export async function streams(target, api) {
  const id = target.season != null && target.episode != null
    ? `${target.id}:${target.season}:${target.episode}`
    : target.id
  const response = await api.fetch(
    `https://torrentio.strem.fun/stream/${target.type}/${encodeURIComponent(id)}.json`,
  )
  if (!response.ok) throw new Error(`torrentio answered ${response.status}`)
  const body = await response.json()
  return Array.isArray(body.streams) ? body.streams : []
}
```

Troque `<owner>` pelo dono real antes do primeiro push: é esse endereço que fica travado como identidade de quem instalar.

- [ ] **Step 2: Create and push the repository**

```bash
mkdir -p ~/projects/ss-plugin-torrentio && cd ~/projects/ss-plugin-torrentio
git init
# escreva plugin.js, README.md e LICENSE
git add -A && git commit -m "feat: torrentio source plugin for ss"
gh repo create ss-plugin-torrentio --public --source=. --push
```

- [ ] **Step 3: Install it and verify end to end**

Rode `cd web && npm run dev`, abra o painel de plugins, cole a URL do repositório, confirme que a tela de confirmação mostra `torrentio.strem.fun` e instale. Abra um filme e confirme que a lista de fontes aparece.

- [ ] **Step 4: Point the README at it**

O `README.md` deste repositório não menciona Torrentio, addon nem fontes em lugar nenhum — o catálogo entrou nos commits recentes e nunca foi documentado ali. Confira com `grep -in "torrentio\|addon\|fonte" README.md` antes de procurar a seção que não existe.

Então isto é um acréscimo, não uma substituição: na seção que lista o que está pronto, uma linha dizendo que as fontes do catálogo vêm de plugins instalados pelo host, com o link para `https://ss.giuli.dev/docs`.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: point sources at the plugin system"
```

---

### Task 16: As docs, e o servidor as entregando

**Files:**
- Create (fora deste repositório): repositório `ss-docs` — Astro + Starlight + `toolbeam-docs-theme`
- Modify: `internal/httpapi/server.go` (`registerFrontend` e `privacyHeaders`)
- Modify: `web/vite.config.ts` (nome de saída do worker)
- Test: `internal/httpapi/server_test.go`
- Modify: o script de deploy usado hoje (rsync para `/opt/ss`)

**Interfaces:**
- Consumes: nada do código do aplicativo.
- Produces: `WEB_DIR/docs` servido em `/docs`.

- [ ] **Step 1: Write the failing test for the route**

```go
// acrescente a internal/httpapi/server_test.go
func TestDocsPathDoesNotFallBackToTheApp(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "docs", "index.html"), []byte("<h1>docs</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>app</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := newServerWithWebDir(t, dir)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/docs/", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "docs") {
		t.Fatalf("docs index: status %d body %q", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/docs/nope", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing docs page = %d, want 404 rather than the app shell", rec.Code)
	}
}
```

`server_test.go` importa `net/http`, `net/http/httptest`, `os`, `path/filepath`, `testing` e `testify/require` — **não** `strings`, que o teste acima usa. Acrescente-o.

`newServerWithWebDir` é o helper que falta, e ele é as linhas 20-22 do arquivo:

```go
func newServerWithWebDir(t *testing.T, webDir string) http.Handler {
	t.Helper()
	cfg := testCfg(t)
	cfg.WebDir = webDir
	return NewServer(cfg, newTestStore(t), nil)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/httpapi/ -run TestDocsPath`
Expected: FAIL — `/docs/nope` devolve 200 com o shell do aplicativo.

- [ ] **Step 3: Serve the docs**

Em `internal/httpapi/server.go`, dentro de `registerFrontend`, antes do `NoRoute`:

```go
	r.Static("/docs", filepath.Join(webDir, "docs"))
```

e dentro do `NoRoute`, acrescente `/docs/` à lista de prefixos que respondem 404 em vez do `index.html`:

```go
		if c.Request.Method != http.MethodGet || strings.HasPrefix(c.Request.URL.Path, "/api/") ||
			strings.HasPrefix(c.Request.URL.Path, "/media/") || strings.HasPrefix(c.Request.URL.Path, "/ws/") ||
			strings.HasPrefix(c.Request.URL.Path, "/docs/") {
```

Um endereço de documentação errado deve dizer que está errado, não abrir o site.

- [ ] **Step 4: Give the plugin worker its own Content-Security-Policy**

Esta é a única camada do isolamento que o código do plugin não consegue contornar por construção, e é ela que fecha o `import()` remoto que a Task 4 não consegue fechar de dentro do worker.

Primeiro dê ao worker um nome de arquivo previsível, em `web/vite.config.ts`, junto do `worker: { format: 'es' }` da Task 4:

```ts
  worker: {
    format: 'es',
    // A stable prefix so the server can recognise this one response and give
    // it a policy the rest of the app must not have.
    rollupOptions: { output: { entryFileNames: 'assets/plugin-worker-[hash].js' } },
  },
```

Depois, em `internal/httpapi/server.go`, dentro de `privacyHeaders`:

```go
		// The plugin worker gets a policy of its own. `connect-src 'none'`
		// removes every network API from that context — including the ones a
		// plugin could reach through the prototype chain if the bootstrap
		// missed one. `script-src blob:` is the exception it needs to exist
		// at all: the plugin's own module is imported from a blob URL. What
		// it does NOT allow is https, so `import('https://…')`, which nothing
		// inside a worker can take away, is refused here.
		if strings.HasPrefix(c.Request.URL.Path, "/assets/plugin-worker-") {
			c.Header("Content-Security-Policy", "default-src 'none'; script-src blob:; connect-src 'none'")
		}
```

E um teste, no mesmo arquivo do anterior:

```go
func TestPluginWorkerIsServedWithItsOwnPolicy(t *testing.T) {
	webDir := t.TempDir()
	require.NoError(t, os.Mkdir(filepath.Join(webDir, "assets"), 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(webDir, "assets", "plugin-worker-abc.js"), []byte("//"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(webDir, "assets", "app-abc.js"), []byte("//"), 0o644))
	server := newServerWithWebDir(t, webDir)

	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/plugin-worker-abc.js", nil))
	require.Contains(t, rec.Header().Get("Content-Security-Policy"), "connect-src 'none'")

	// And the app itself must not inherit it, or nothing would reach /api.
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/app-abc.js", nil))
	require.Empty(t, rec.Header().Get("Content-Security-Policy"))
}
```

Verifique à mão depois do build: `cd web && npm run build && ls dist/assets/plugin-worker-*`. Se não existir arquivo com esse prefixo, a política não está sendo aplicada a nada e o passo falhou em silêncio.

- [ ] **Step 5: Scaffold the docs repository**

```bash
mkdir -p ~/projects/ss-docs && cd ~/projects/ss-docs
npm create astro@latest . -- --template minimal --no-install --no-git --typescript strict
npm install @astrojs/starlight toolbeam-docs-theme
```

`astro.config.mjs`:

```js
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import theme from 'toolbeam-docs-theme'

export default defineConfig({
  site: 'https://ss.giuli.dev',
  base: '/docs',
  integrations: [
    starlight({
      title: 'ss',
      plugins: [theme({ headerLinks: [{ name: 'ss.giuli.dev', url: 'https://ss.giuli.dev' }] })],
      sidebar: [
        { label: 'Começando', items: ['index', 'salas'] },
        { label: 'Plugins', items: ['plugins/index', 'plugins/instalar', 'plugins/escrever', 'plugins/referencia'] },
      ],
    }),
  ],
})
```

- [ ] **Step 6: Write the pages**

Sete arquivos em `src/content/docs/`: `index.md`, `salas.md`, `plugins/index.md`, `plugins/instalar.md`, `plugins/escrever.md`, `plugins/referencia.md`.

Escreva com dois subagentes Opus 5 low, no máximo dois, cada um instruído a **ler primeiro** `https://github.com/conorbronsdon/avoid-ai-writing/blob/main/SKILL.md` e a seguir aquilo à risca. Divida assim:

- Agente 1 — `index.md`, `salas.md`, `plugins/index.md`: o que o ss é, como uma sala funciona, por que o sistema de plugins existe e o que um plugin pode e não pode.
- Agente 2 — `plugins/instalar.md`, `plugins/escrever.md`, `plugins/referencia.md`: instalar por arquivo e por repositório, ligar, atualizar, remover; o contrato com um exemplo completo; e a referência de `manifest`, `target`, `api.fetch`, formato de stream e limites.

Fatos que as docs precisam trazer e que só existem neste plano — passe-os aos agentes:

- O manifest e seus campos, exatamente como na Task 1, incluindo que `hosts` são nomes de host puros.
- A identidade é a origem travada na instalação; o hash SHA-256 é exibido para conferência, não é identidade; uma atualização que mude `updateUrl` é recusada; uma que peça hosts novos fica retida pedindo aval.
- Os limites de execução: 15 segundos e 32 requisições por resolução, worker novo a cada resolução, sem estado entre chamadas.
- O limite honesto do isolamento, em duas partes, e sem suavizar nenhuma. Primeira: o `import()` de módulo remoto não pode ser removido de dentro do worker — quem o fecha é o cabeçalho `Content-Security-Policy` com que o worker é servido, e é por isso que ele existe. Segunda, e essa não tem conserto: a política de rede casa **nomes de host**, não endereços, então um plugin pode declarar um host que resolve para a rede local de quem o instalou e fazer o navegador bater ali. O CORS impede o plugin de ler a resposta, mas não impede o pedido. O que a caixa garante é que o plugin não alcança a origem do site, sua API nem seu armazenamento — não contenção total.
- Que só o Plex é fonte nativa, e por quê; e que ele não é um plugin.
- Um stream aponta por `infoHash` (com `fileIdx` opcional) ou por `url` https; `http` é recusado.
- Só o host precisa de plugin; quem entra como espectador pede o título ao host.

- [ ] **Step 7: Build and wire the deploy**

```bash
cd ~/projects/ss-docs && npm run build   # gera dist/
```

No script de deploy do ss, depois do rsync do `web/dist`, acrescente o passo que copia o build das docs para `WEB_DIR/docs` na VPS. Se o deploy hoje é um rsync manual para `/opt/ss`, o passo novo é um segundo rsync de `~/projects/ss-docs/dist/` para `/opt/ss/web/dist/docs/`, preservando o que a memória do projeto já diz sobre preservar `.env`, override e `livekit.yaml`.

- [ ] **Step 8: Verify and commit**

Run: `go test ./internal/httpapi/ && cd web && npm run build`

Suba e confirme visualmente em `https://ss.giuli.dev/docs` — a memória do projeto pede confirmação visual em produção depois de todo deploy.

```bash
git add internal/httpapi/server.go internal/httpapi/server_test.go
git commit -m "feat: serve the documentation at /docs"
```

---

### Task 17: A conta do Plex — parear e guardar o token

O Plex é fonte nativa, não plugin. A razão está na spec e vale repetir aqui, porque ela decide a forma do código: o Plex precisa de um fluxo de pareamento, de uma credencial de conta guardada entre sessões e de descoberta de servidor. Dar isso ao contrato de plugin seria dar isso a todo plugin.

**Files:**
- Create: `web/src/plex/account.ts`
- Test: `web/src/plex/account.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `clientIdentifier(): Promise<string>` — o `X-Plex-Client-Identifier`, gerado uma vez e guardado
  - `createPin(deps?: PlexDeps): Promise<{ id: number; code: string; authUrl: string }>`
  - `pollPin(id: number, deps?: PlexDeps): Promise<string | null>` — o token, ou `null` enquanto não aprovado
  - `getToken(): Promise<string | null>`, `setToken(token: string): Promise<void>`, `clearToken(): Promise<void>`
  - `interface PlexDeps { fetch?: typeof globalThis.fetch }`

- [ ] **Step 1: Write the failing test**

```ts
// web/src/plex/account.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToken, clientIdentifier, createPin, getToken, pollPin, setToken } from './account'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('clientIdentifier', () => {
  it('is stable across calls', async () => {
    const first = await clientIdentifier()
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(await clientIdentifier()).toBe(first)
  })
})

describe('createPin', () => {
  it('asks plex.tv for a pin and builds the url the person has to visit', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 42, code: 'WXYZ' }))
    const pin = await createPin({ fetch: fetchMock as unknown as typeof fetch })
    expect(pin).toMatchObject({ id: 42, code: 'WXYZ' })
    expect(pin.authUrl).toContain('app.plex.tv/auth')
    expect(pin.authUrl).toContain('code=WXYZ')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://plex.tv/api/v2/pins?strong=true')
    expect(init.method).toBe('POST')
    // Without this header plex.tv answers 400, and the failure reads as
    // "the pin endpoint is broken" rather than "you forgot a header".
    expect((init.headers as Record<string, string>)['X-Plex-Client-Identifier']).toBeTruthy()
    expect((init.headers as Record<string, string>).Accept).toBe('application/json')
  })
})

describe('pollPin', () => {
  it('answers null while the pin is still waiting for approval', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 42, authToken: null }))
    await expect(pollPin(42, { fetch: fetchMock as unknown as typeof fetch })).resolves.toBeNull()
  })

  it('answers the token once it has been approved', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ id: 42, authToken: 'tok_abc' }))
    await expect(pollPin(42, { fetch: fetchMock as unknown as typeof fetch })).resolves.toBe('tok_abc')
  })

  it('treats an expired pin as an error, not as still waiting', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'gone' }, 404))
    await expect(pollPin(42, { fetch: fetchMock as unknown as typeof fetch })).rejects.toThrow(/expired|404/i)
  })
})

describe('the token', () => {
  beforeEach(async () => { await clearToken() })

  it('is absent until one is stored', async () => {
    expect(await getToken()).toBeNull()
  })

  it('survives being written and read back', async () => {
    await setToken('tok_abc')
    expect(await getToken()).toBe('tok_abc')
  })

  it('can be forgotten, which is the whole point of having a disconnect button', async () => {
    await setToken('tok_abc')
    await clearToken()
    expect(await getToken()).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plex/account.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write minimal implementation**

```ts
// web/src/plex/account.ts

/**
 * Pairing with a Plex account, and the credential it produces.
 *
 * We never ask for the person's Plex password. The PIN flow is what Plex
 * offers third-party clients: we ask for a code, they approve it inside Plex
 * itself, and we poll until a token comes back.
 *
 * The token lives in IndexedDB rather than localStorage. It is an account
 * credential, not a preference, and it should be as easy to delete as it was
 * to obtain — see clearToken, which the panel's disconnect button calls.
 */

export interface PlexDeps {
  fetch?: typeof globalThis.fetch
}

const DB_NAME = 'ss-plex'
const DB_VERSION = 1
const STORE = 'account'
const TOKEN_KEY = 'authToken'
const CLIENT_KEY = 'clientIdentifier'

const PRODUCT = 'ss'
const VERSION = '1.0.0'

let connection: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (connection) return connection
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('plex store failed to open'))
  })
  return connection
}

function read(key: string): Promise<string | null> {
  return open().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).get(key) as IDBRequest<string | undefined>
    let value: string | undefined
    request.onsuccess = () => { value = request.result }
    transaction.oncomplete = () => resolve(value ?? null)
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('plex store read failed'))
  }))
}

function write(key: string, value: string | null): Promise<void> {
  return open().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    if (value === null) store.delete(key)
    else store.put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error('plex store write failed'))
  }))
}

/**
 * This installation's opaque identity, as far as plex.tv is concerned.
 *
 * It is not optional: `POST /api/v2/pins` answers 400 without it, and so does
 * resource discovery. It has to be the same value across both, and across
 * restarts, or a pin approved by one identity is invisible to the other.
 */
export async function clientIdentifier(): Promise<string> {
  const existing = await read(CLIENT_KEY)
  if (existing) return existing
  const fresh = crypto.randomUUID()
  await write(CLIENT_KEY, fresh)
  return fresh
}

export async function plexHeaders(): Promise<Record<string, string>> {
  return {
    Accept: 'application/json',
    'X-Plex-Product': PRODUCT,
    'X-Plex-Version': VERSION,
    'X-Plex-Client-Identifier': await clientIdentifier(),
  }
}

export async function createPin(deps: PlexDeps = {}): Promise<{ id: number; code: string; authUrl: string }> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await request('https://plex.tv/api/v2/pins?strong=true', {
    method: 'POST',
    headers: await plexHeaders(),
  })
  if (!response.ok) throw new Error(`plex pin request failed (${response.status})`)
  const body = await response.json() as { id?: unknown; code?: unknown }
  if (typeof body.id !== 'number' || typeof body.code !== 'string') {
    throw new Error('plex pin request returned no pin')
  }
  const params = new URLSearchParams({
    clientID: await clientIdentifier(),
    code: body.code,
    'context[device][product]': PRODUCT,
  })
  return { id: body.id, code: body.code, authUrl: `https://app.plex.tv/auth#?${params.toString()}` }
}

export async function pollPin(id: number, deps: PlexDeps = {}): Promise<string | null> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await request(`https://plex.tv/api/v2/pins/${id}`, { headers: await plexHeaders() })
  // A pin expires after a few minutes. Reporting that as "still waiting"
  // would poll for ever against something that will never answer.
  if (response.status === 404) throw new Error('plex pin expired')
  if (!response.ok) throw new Error(`plex pin poll failed (${response.status})`)
  const body = await response.json() as { authToken?: unknown }
  return typeof body.authToken === 'string' && body.authToken !== '' ? body.authToken : null
}

export function getToken(): Promise<string | null> {
  return read(TOKEN_KEY)
}

export function setToken(token: string): Promise<void> {
  return write(TOKEN_KEY, token)
}

export function clearToken(): Promise<void> {
  return write(TOKEN_KEY, null)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/plex/account.test.ts`
Expected: PASS, 9 tests.

`crypto.randomUUID` existe no jsdom pelo polyfill de `webcrypto` que a Task 5 acrescentou ao `setup.ts`. Se falhar aqui, é porque a Task 5 não foi feita.

- [ ] **Step 5: Commit**

```bash
git add web/src/plex/account.ts web/src/plex/account.test.ts
git commit -m "feat: pair with a plex account without asking for a password"
```

---

### Task 18: Achar o servidor e navegar a biblioteca

**Files:**
- Create: `web/src/plex/server.ts`
- Test: `web/src/plex/server.test.ts`
- Create: `web/src/plex/library.ts`
- Test: `web/src/plex/library.test.ts`

**Interfaces:**
- Consumes: `plexHeaders`/`getToken` (Task 17).
- Produces:
  - `type PlexConnection = { uri: string; local: boolean; relay: boolean }`
  - `type PlexServer = { name: string; clientIdentifier: string; connections: PlexConnection[] }`
  - `listServers(token: string, deps?: PlexDeps): Promise<PlexServer[]>`
  - `pickConnection(server: PlexServer, token: string, deps?: PlexDeps): Promise<PlexConnection>`
  - `type PlexItem = { ratingKey: string; title: string; year: number | null; type: 'movie' | 'episode'; partKey: string; size: number; container: string }`
  - `listSections`, `searchLibrary`, `itemDetails`, `partUrl(base, partKey, token)`

- [ ] **Step 1: Write the failing test for discovery**

```ts
// web/src/plex/server.test.ts
import { describe, expect, it, vi } from 'vitest'
import { listServers, pickConnection } from './server'

const resources = [
  {
    name: 'Casa', clientIdentifier: 'srv1', provides: 'server',
    connections: [
      { uri: 'https://10-0-0-5.hash.plex.direct:32400', local: true, relay: false },
      { uri: 'https://1.2.3.4.hash.plex.direct:32400', local: false, relay: false },
      { uri: 'https://relay.plex.direct:443', local: false, relay: true },
    ],
  },
  { name: 'Um telefone', clientIdentifier: 'p1', provides: 'player', connections: [] },
]

describe('listServers', () => {
  it('keeps the servers and drops everything else on the account', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(resources), { status: 200 }))
    const servers = await listServers('tok', { fetch: fetchMock as unknown as typeof fetch })
    expect(servers.map((server) => server.name)).toEqual(['Casa'])
    expect(servers[0].connections).toHaveLength(3)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('includeHttps=1')
    expect(url).toContain('includeRelay=1')
    expect((init.headers as Record<string, string>)['X-Plex-Token']).toBe('tok')
  })
})

describe('pickConnection', () => {
  it('takes the first connection that answers, not the first in the list', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      // The LAN address is listed first and is the one that does not answer.
      if (url.startsWith('https://10-0-0-5')) throw new Error('unreachable')
      return new Response('{}', { status: 200 })
    })
    const chosen = await pickConnection(resources[0] as never, 'tok', { fetch: fetchMock as unknown as typeof fetch })
    expect(chosen.uri).toBe('https://1.2.3.4.hash.plex.direct:32400')
  })

  it('prefers the LAN when the LAN answers, because relay is metered and slow', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    const chosen = await pickConnection(resources[0] as never, 'tok', { fetch: fetchMock as unknown as typeof fetch })
    expect(chosen.local).toBe(true)
  })

  it('says so when nothing answers, rather than returning a connection that does not work', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('unreachable') })
    await expect(pickConnection(resources[0] as never, 'tok', { fetch: fetchMock as unknown as typeof fetch }))
      .rejects.toThrow(/no reachable/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plex/server.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write discovery**

```ts
// web/src/plex/server.ts
import { plexHeaders, type PlexDeps } from './account'

export interface PlexConnection {
  uri: string
  local: boolean
  relay: boolean
}

export interface PlexServer {
  name: string
  clientIdentifier: string
  connections: PlexConnection[]
}

/** How long a connection gets to prove it is reachable. */
const PROBE_TIMEOUT_MS = 4_000

export async function listServers(token: string, deps: PlexDeps = {}): Promise<PlexServer[]> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await request('https://plex.tv/api/v2/resources?includeHttps=1&includeRelay=1', {
    headers: { ...await plexHeaders(), 'X-Plex-Token': token },
  })
  if (!response.ok) throw new Error(`plex resources failed (${response.status})`)
  const body = await response.json() as unknown
  if (!Array.isArray(body)) return []
  return body
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .filter((entry) => typeof entry.provides === 'string' && entry.provides.split(',').includes('server'))
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : 'Plex',
      clientIdentifier: typeof entry.clientIdentifier === 'string' ? entry.clientIdentifier : '',
      connections: (Array.isArray(entry.connections) ? entry.connections : [])
        .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
        .filter((c) => typeof c.uri === 'string' && c.uri.startsWith('https://'))
        .map((c) => ({ uri: c.uri as string, local: c.local === true || c.local === 1, relay: c.relay === true || c.relay === 1 })),
    }))
}

/**
 * Finds a connection that actually works.
 *
 * Which one that is cannot be decided on paper: a LAN address is the fastest
 * when the host is at home and unreachable when they are not, and a relay
 * always works and is metered. So every connection is probed at once and the
 * ranking only breaks ties among the ones that answered.
 *
 * The LAN address is HTTPS with a real certificate because of plex.direct,
 * which is a DNS trick: 10-0-0-5.<hash>.plex.direct resolves to 10.0.0.5 and
 * carries a wildcard cert. It is the only reason a page on ss.giuli.dev can
 * talk to a box on someone's home network at all.
 */
export async function pickConnection(server: PlexServer, token: string, deps: PlexDeps = {}): Promise<PlexConnection> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const headers = { ...await plexHeaders(), 'X-Plex-Token': token }

  const reachable = await Promise.all(server.connections.map(async (connection) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
    try {
      const response = await request(`${connection.uri}/identity`, { headers, signal: abort.signal })
      return response.ok ? connection : null
    } catch {
      // A LAN address from outside the LAN, or a router refusing a DNS answer
      // that points at a private address. Neither is worth reporting on its
      // own; what matters is whether anything answered.
      return null
    } finally {
      clearTimeout(timer)
    }
  }))

  const answered = reachable.filter((connection): connection is PlexConnection => connection !== null)
  if (answered.length === 0) throw new Error('plex: no reachable connection to this server')
  const rank = (connection: PlexConnection) => (connection.local ? 0 : connection.relay ? 2 : 1)
  return answered.sort((a, b) => rank(a) - rank(b))[0]
}
```

- [ ] **Step 4: Write the failing test for the library**

```ts
// web/src/plex/library.test.ts
import { describe, expect, it, vi } from 'vitest'
import { itemDetails, partUrl, searchLibrary } from './library'

const base = 'https://10-0-0-5.hash.plex.direct:32400'
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('searchLibrary', () => {
  it('reads titles out of a plex search response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      MediaContainer: {
        Metadata: [
          { ratingKey: '11', title: 'Duna', year: 2021, type: 'movie' },
          { ratingKey: '12', title: 'Um artista', year: 2019, type: 'artist' },
        ],
      },
    }))
    const found = await searchLibrary(base, 'tok', 'duna', { fetch: fetchMock as unknown as typeof fetch })
    // Music and photos are on the same account and are not what a watch party
    // is for.
    expect(found.map((item) => item.title)).toEqual(['Duna'])
    expect(String(fetchMock.mock.calls[0][0])).toContain('query=duna')
  })
})

describe('itemDetails', () => {
  it('finds the file behind a title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      MediaContainer: {
        Metadata: [{
          ratingKey: '11', title: 'Duna', year: 2021, type: 'movie',
          Media: [{ container: 'mkv', Part: [{ key: '/library/parts/9/1600/file.mkv', size: 1234567 }] }],
        }],
      },
    }))
    const item = await itemDetails(base, 'tok', '11', { fetch: fetchMock as unknown as typeof fetch })
    expect(item).toMatchObject({ title: 'Duna', partKey: '/library/parts/9/1600/file.mkv', size: 1234567, container: 'mkv' })
  })

  it('is explicit when the title has no file behind it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ MediaContainer: { Metadata: [{ ratingKey: '11', title: 'Duna' }] } }))
    await expect(itemDetails(base, 'tok', '11', { fetch: fetchMock as unknown as typeof fetch }))
      .rejects.toThrow(/no playable file/i)
  })
})

describe('partUrl', () => {
  it('builds a url the browser can range-request', () => {
    expect(partUrl(base, '/library/parts/9/1600/file.mkv', 'tok'))
      .toBe(`${base}/library/parts/9/1600/file.mkv?download=1&X-Plex-Token=tok`)
  })
})
```

- [ ] **Step 5: Write the library**

```ts
// web/src/plex/library.ts
import { plexHeaders, type PlexDeps } from './account'

export interface PlexItem {
  ratingKey: string
  title: string
  year: number | null
  type: 'movie' | 'episode'
  partKey: string
  size: number
  container: string
}

/** What a watch party can play. The account may also hold music and photos. */
const PLAYABLE = new Set(['movie', 'episode'])

async function get(base: string, token: string, path: string, deps: PlexDeps): Promise<Record<string, unknown>> {
  const request = deps.fetch ?? globalThis.fetch.bind(globalThis)
  const response = await request(`${base}${path}`, {
    headers: { ...await plexHeaders(), 'X-Plex-Token': token },
  })
  if (!response.ok) throw new Error(`plex request failed (${response.status})`)
  return await response.json() as Record<string, unknown>
}

function metadata(body: Record<string, unknown>): Record<string, unknown>[] {
  const container = body.MediaContainer as Record<string, unknown> | undefined
  const list = container?.Metadata
  return Array.isArray(list) ? list.filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null) : []
}

export async function listSections(base: string, token: string, deps: PlexDeps = {}): Promise<{ key: string; title: string }[]> {
  const body = await get(base, token, '/library/sections', deps)
  const container = body.MediaContainer as Record<string, unknown> | undefined
  const directories = Array.isArray(container?.Directory) ? container.Directory : []
  return directories
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .filter((entry) => entry.type === 'movie' || entry.type === 'show')
    .map((entry) => ({ key: String(entry.key ?? ''), title: String(entry.title ?? '') }))
}

/** Titles only — the file behind one is read separately, by itemDetails. */
export async function searchLibrary(
  base: string, token: string, query: string, deps: PlexDeps = {},
): Promise<Pick<PlexItem, 'ratingKey' | 'title' | 'year' | 'type'>[]> {
  const body = await get(base, token, `/search?query=${encodeURIComponent(query)}`, deps)
  return metadata(body)
    .filter((entry) => typeof entry.type === 'string' && PLAYABLE.has(entry.type))
    .map((entry) => ({
      ratingKey: String(entry.ratingKey ?? ''),
      title: String(entry.title ?? ''),
      year: typeof entry.year === 'number' ? entry.year : null,
      type: entry.type as 'movie' | 'episode',
    }))
}

export async function itemDetails(base: string, token: string, ratingKey: string, deps: PlexDeps = {}): Promise<PlexItem> {
  const body = await get(base, token, `/library/metadata/${encodeURIComponent(ratingKey)}`, deps)
  const [entry] = metadata(body)
  if (!entry) throw new Error('plex: no such item')
  const media = Array.isArray(entry.Media) ? entry.Media[0] as Record<string, unknown> | undefined : undefined
  const part = media && Array.isArray(media.Part) ? media.Part[0] as Record<string, unknown> | undefined : undefined
  if (!part || typeof part.key !== 'string') throw new Error('plex: this title has no playable file')
  return {
    ratingKey: String(entry.ratingKey ?? ratingKey),
    title: String(entry.title ?? ''),
    year: typeof entry.year === 'number' ? entry.year : null,
    type: entry.type === 'episode' ? 'episode' : 'movie',
    partKey: part.key,
    size: typeof part.size === 'number' ? part.size : 0,
    container: typeof media?.container === 'string' ? media.container : 'mkv',
  }
}

/**
 * The original file, not a transcode.
 *
 * `download=1` is what asks for direct play, and it is also where this fails
 * for some accounts: Plex only serves the original file to a user with
 * "Allow Downloads" enabled. A 403 here means that setting, not a bad token,
 * and the interface has to say so — otherwise it reads as a login problem
 * and the person re-pairs for ever.
 */
export function partUrl(base: string, partKey: string, token: string): string {
  return `${base}${partKey}?download=1&X-Plex-Token=${encodeURIComponent(token)}`
}
```

- [ ] **Step 6: Run tests and commit**

Run: `cd web && npx vitest run src/plex/ && npx tsc -b && npx oxlint src`
Expected: PASS.

```bash
git add web/src/plex/server.ts web/src/plex/server.test.ts web/src/plex/library.ts web/src/plex/library.test.ts
git commit -m "feat: find a plex server and read its library"
```

---

### Task 19: Tocar um arquivo do Plex numa sala

Duas rotas, e qual delas serve foi decidido pela corrida de conexões da Task 18.

Se a conexão vencedora é pública — WAN ou relay — a URL é HTTPS e alcançável de fora, e isso é a ingestão por URL da Task 13: o servidor puxa sozinho e a aba do host pode fechar.

Se venceu a de LAN, a VPS não alcança `192.168.x.x`, e não vai passar a alcançar — abrir a guarda de SSRF para endereço privado é desfazer a guarda. Quem bombeia é o navegador do host, que já está na mesma rede. E essa bomba já existe: `startTorrentTransfer` é exatamente ela. Esta task a generaliza em vez de escrever uma segunda.

**Files:**
- Modify: `web/src/upload.ts` (extrair a bomba, acrescentar a fonte de URL com range)
- Test: `web/src/upload.test.ts`
- Create: `web/src/plex/open.ts`
- Test: `web/src/plex/open.test.ts`

**Interfaces:**
- Consumes: `startUrlTransfer`/`createRoomAndIngestUrl` (Task 14), `partUrl`/`PlexItem` (Task 18).
- Produces:
  - `interface ChunkSource { name: string; size: number; subtitleFiles: SubtitleFile[]; read(at: number, end: number): Promise<ArrayBuffer>; destroy(): void }`
  - `startRemoteTransfer(roomID, uploadEndpoint, startBytes, mediaGeneration, source: ChunkSource, onProgress?)`
  - `rangeSource(url: string, name: string, size: number): ChunkSource`
  - `openPlexItem(connection: PlexConnection, item: PlexItem, token: string): PlexOpen` onde `PlexOpen = { kind: 'server-pull'; url: string; fileName: string; size: number } | { kind: 'browser-pump'; source: ChunkSource; fileName: string }`

- [ ] **Step 1: Write the failing test for the decision**

```ts
// web/src/plex/open.test.ts
import { describe, expect, it } from 'vitest'
import { openPlexItem } from './open'

const item = {
  ratingKey: '11', title: 'Duna', year: 2021, type: 'movie' as const,
  partKey: '/library/parts/9/1600/file.mkv', size: 1234567, container: 'mkv',
}

describe('openPlexItem', () => {
  it('lets the server pull when the connection is reachable from outside', () => {
    const open = openPlexItem(
      { uri: 'https://1-2-3-4.hash.plex.direct:32400', local: false, relay: false }, item, 'tok',
    )
    expect(open).toMatchObject({ kind: 'server-pull', size: 1234567 })
    expect(open.kind === 'server-pull' && open.url).toContain('X-Plex-Token=tok')
    expect(open.fileName).toBe('Duna.mkv')
  })

  it('pumps from the browser when the server is only reachable on the local network', () => {
    const open = openPlexItem(
      { uri: 'https://10-0-0-5.hash.plex.direct:32400', local: true, relay: false }, item, 'tok',
    )
    // The VPS cannot reach 10.0.0.5, and the SSRF guard will not be opened to
    // let it try. The host's browser is already on that network.
    expect(open.kind).toBe('browser-pump')
  })

  it('pumps from the browser for a relay too, because relay bandwidth is the account owner to spend', () => {
    const open = openPlexItem(
      { uri: 'https://relay.plex.direct:443', local: false, relay: true }, item, 'tok',
    )
    expect(open.kind).toBe('browser-pump')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plex/open.test.ts`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write the failing test for the ranged source**

Acrescente a `web/src/upload.test.ts` — sem imports novos além de `rangeSource` na linha 2:

```ts
describe('rangeSource', () => {
  it('asks for exactly the byte range the pump wants', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'Content-Type': 'video/x-matroska' } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const source = rangeSource('https://plex.local/file.mkv', 'Duna.mkv', 3000)
    const chunk = await source.read(100, 199)
    expect(chunk.byteLength).toBe(3)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>).Range).toBe('bytes=100-199')
    vi.unstubAllGlobals()
  })

  it('fails loudly when the origin ignores the range', async () => {
    // A 200 here means the whole file is coming, and writing that at a
    // non-zero offset corrupts the upload silently — the worst outcome.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 })))
    const source = rangeSource('https://plex.local/file.mkv', 'Duna.mkv', 3000)
    await expect(source.read(100, 199)).rejects.toThrow(/range/i)
    vi.unstubAllGlobals()
  })

  it('names the Allow Downloads problem when plex refuses the original file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })))
    const source = rangeSource('https://plex.local/file.mkv', 'Duna.mkv', 3000)
    await expect(source.read(0, 99)).rejects.toThrow(/allow downloads/i)
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 4: Generalise the pump**

Em `web/src/upload.ts`:

1. Declare `ChunkSource`, e note que ele é exatamente o que `startTorrentTransfer` já consome do WebTorrent:

```ts
/**
 * Somewhere bytes can be read from by offset. The torrent path reads from a
 * swarm and the Plex path from an HTTPS range request; the tus pump between
 * them is the same code and always was.
 */
export interface ChunkSource {
  name: string
  size: number
  /** Sibling subtitle files, if the source has any. */
  subtitleFiles: { name: string; read(): Promise<ArrayBuffer> }[]
  /** Inclusive on both ends, like an HTTP Range. */
  read(at: number, end: number): Promise<ArrayBuffer>
  destroy(): void
}
```

2. Renomeie `startTorrentTransfer` para `startRemoteTransfer` e troque a assinatura de `source: { file, session }` para `source: ChunkSource`. Dentro do corpo, `file.size` vira `source.size`, `file.name` vira `source.name`, `file.read(at, end)` vira `source.read(at, end)`, `session.destroy` vira `source.destroy`, `session.subtitleFiles` vira `source.subtitleFiles`, e `isMatroska(file)` passa a olhar `source.name`. **Nada mais muda** — o laço de `PATCH`, o prefetch de um slot, o coletor de legendas e o `DELETE` de limpeza ficam idênticos.

3. Devolva `startTorrentTransfer` como um adaptador fino, para que Home e Room não mudem:

```ts
export function startTorrentTransfer(
  roomID: string, uploadEndpoint: string, startBytes: number, mediaGeneration: number,
  source: { file: TorrentFile; session: TorrentSession }, onProgress?: (progress: UploadProgress) => void,
): void {
  const { file, session } = source
  startRemoteTransfer(roomID, uploadEndpoint, startBytes, mediaGeneration, {
    name: file.name,
    size: file.size,
    subtitleFiles: session.subtitleFiles.map((entry) => ({ name: entry.name, read: () => entry.read() })),
    read: (at, end) => file.read(at, end),
    destroy: () => session.destroy(),
  }, onProgress)
}
```

Leia os tipos reais de `TorrentFile`/`TorrentSession` no arquivo antes de escrever isto; use os nomes que estiverem lá. Se `subtitleFiles` já tiver a forma `{ name, read }`, passe a lista direto em vez de mapear.

4. Acrescente a fonte de URL:

```ts
/**
 * A ChunkSource backed by HTTP range requests.
 *
 * This is the path a Plex server on the local network takes: the VPS cannot
 * reach 192.168.x.x, and the SSRF guard exists precisely so that it never
 * will. The host's browser is already on that network, so it does the pumping.
 */
export function rangeSource(url: string, name: string, size: number): ChunkSource {
  return {
    name,
    size,
    subtitleFiles: [],
    destroy: () => undefined,
    async read(at: number, end: number): Promise<ArrayBuffer> {
      const response = await fetch(url, { headers: { Range: `bytes=${at}-${end}` }, credentials: 'omit' })
      if (response.status === 403) {
        // Plex only hands over the original file to an account with
        // "Allow Downloads" enabled. Reporting a bare 403 sends people to
        // re-pair their account, which is not the problem.
        throw new Error('plex refused the original file — enable Allow Downloads for this user')
      }
      if (!response.ok) throw new Error(`source read failed (${response.status})`)
      if (response.status !== 206 && at > 0) {
        throw new Error('source ignored the range request')
      }
      return await response.arrayBuffer()
    },
  }
}
```

- [ ] **Step 5: Write the decision**

```ts
// web/src/plex/open.ts
import { rangeSource, type ChunkSource } from '../upload'
import { partUrl, type PlexItem } from './library'
import type { PlexConnection } from './server'

export type PlexOpen =
  | { kind: 'server-pull'; url: string; fileName: string; size: number }
  | { kind: 'browser-pump'; source: ChunkSource; fileName: string; size: number }

/**
 * Decides who fetches the bytes.
 *
 * A public connection goes to the server, which means the transfer survives
 * the host closing the tab. A LAN connection cannot: the server has no route
 * to a private address and is not going to be given one. A relay could go
 * either way and goes to the browser on purpose — relay bandwidth belongs to
 * the account holder, and it is not ours to spend on their behalf.
 */
export function openPlexItem(connection: PlexConnection, item: PlexItem, token: string): PlexOpen {
  const url = partUrl(connection.uri, item.partKey, token)
  const fileName = `${item.title}.${item.container}`
  if (connection.local || connection.relay) {
    return { kind: 'browser-pump', source: rangeSource(url, fileName, item.size), fileName, size: item.size }
  }
  return { kind: 'server-pull', url, fileName, size: item.size }
}
```

- [ ] **Step 6: Run everything and commit**

Run: `cd web && npm run test && npx tsc -b && npm run lint`
Expected: verde. A suíte inteira, não só os arquivos novos: o passo 4 mexeu no caminho de torrent, que tem testes próprios.

```bash
git add web/src/upload.ts web/src/upload.test.ts web/src/plex/open.ts web/src/plex/open.test.ts
git commit -m "feat: pump bytes from a plex server, from wherever can reach it"
```

---

### Task 20: O Plex na interface

**Files:**
- Create: `web/src/plex/PlexSection.tsx`
- Test: `web/src/plex/PlexSection.test.tsx`
- Modify: `web/src/plugins/PluginsPanel.tsx`
- Modify: `web/src/pages/Home.tsx`, `web/src/pages/Room.tsx`
- Modify: `web/src/i18n/pt-BR.ts`, `web/src/i18n/en.ts`
- Modify: `web/src/theme.css`

**Interfaces:**
- Consumes: tudo das Tasks 17 a 19, mais `createRoomAndIngestUrl`/`startUrlTransfer` (Task 14).
- Produces: `<PlexSection onPlay={(open: PlexOpen) => void} />`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/plex/PlexSection.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlexSection } from './PlexSection'
import { clearToken, setToken } from './account'

vi.mock('./server', () => ({
  listServers: vi.fn(async () => [{
    name: 'Casa', clientIdentifier: 'srv1',
    connections: [{ uri: 'https://10-0-0-5.hash.plex.direct:32400', local: true, relay: false }],
  }]),
  pickConnection: vi.fn(async () => ({ uri: 'https://10-0-0-5.hash.plex.direct:32400', local: true, relay: false })),
}))

vi.mock('./library', async () => {
  const actual = await vi.importActual<typeof import('./library')>('./library')
  return {
    ...actual,
    searchLibrary: vi.fn(async () => [{ ratingKey: '11', title: 'Duna', year: 2021, type: 'movie' as const }]),
    itemDetails: vi.fn(async () => ({
      ratingKey: '11', title: 'Duna', year: 2021, type: 'movie' as const,
      partKey: '/library/parts/9/1600/file.mkv', size: 1234567, container: 'mkv',
    })),
  }
})

describe('PlexSection', () => {
  beforeEach(async () => { await clearToken() })

  it('offers to connect when no account is paired', async () => {
    render(<PlexSection onPlay={() => undefined} />)
    expect(await screen.findByRole('button', { name: /conectar/i })).toBeInTheDocument()
  })

  it('shows the server it settled on once an account is paired', async () => {
    await setToken('tok')
    render(<PlexSection onPlay={() => undefined} />)
    expect(await screen.findByText('Casa')).toBeInTheDocument()
  })

  it('hands the pick up, with the route already decided', async () => {
    await setToken('tok')
    const onPlay = vi.fn()
    render(<PlexSection onPlay={onPlay} />)
    await userEvent.type(await screen.findByLabelText(/buscar na biblioteca/i), 'duna')
    await userEvent.click(await screen.findByRole('button', { name: /duna/i }))
    // A LAN connection: the browser pumps, because the server cannot reach it.
    await waitFor(() => expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ kind: 'browser-pump' })))
  })

  it('forgets the account when asked, because a token is not a preference', async () => {
    await setToken('tok')
    render(<PlexSection onPlay={() => undefined} />)
    await userEvent.click(await screen.findByRole('button', { name: /desconectar/i }))
    expect(await screen.findByRole('button', { name: /conectar/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/plex/PlexSection.test.tsx`
Expected: FAIL — módulo não encontrado.

- [ ] **Step 3: Write the component**

`PlexSection` é um componente de estados, e são cinco: sem conta, pareando (mostra o código e a instrução, faz poll a cada 2 s), procurando servidor, pronto (nome do servidor, campo de busca, resultados) e erro. Escreva-o com o mesmo vocabulário visual das outras telas — `empty-copy` para os vazios, `primary-button raised` para a ação principal, `plugins-list` para a lista.

Três coisas que precisam estar certas e não são óbvias:

```tsx
  // The pin poll has to stop. A pin expires in minutes and pollPin throws
  // when it does; without this the interval outlives the panel and keeps
  // hitting plex.tv for ever.
  useEffect(() => {
    if (!pin) return
    let stopped = false
    const timer = window.setInterval(async () => {
      try {
        const token = await pollPin(pin.id)
        if (token && !stopped) {
          await setToken(token)
          setPin(null)
        }
      } catch (cause) {
        if (!stopped) {
          setPin(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    }, 2_000)
    return () => { stopped = true; window.clearInterval(timer) }
  }, [pin])
```

```tsx
  // Opening the approval page is the person's move, not ours: a popup opened
  // from an effect is blocked by every browser. It hangs off the button.
  <a href={pin.authUrl} target="_blank" rel="noopener noreferrer">{t('plex.approve')}</a>
```

```tsx
  // Every connection to this server was probed and this one answered. Saying
  // which kind it is matters: on a LAN connection the transfer needs this tab
  // to stay open, and on a public one it does not.
  <p className="empty-copy">{t(connection.local ? 'plex.viaLan' : 'plex.viaInternet')}</p>
```

- [ ] **Step 4: Add the strings**

`web/src/i18n/pt-BR.ts`, e as equivalentes em `en.ts`:

```ts
  'plex.title': 'Plex',
  'plex.connect': 'Conectar conta Plex',
  'plex.disconnect': 'Desconectar',
  'plex.approve': 'Aprovar no Plex',
  'plex.code': 'Aprove este código no Plex:',
  'plex.finding': 'Procurando o servidor…',
  'plex.unreachable': 'Nenhum servidor Plex respondeu. Se ele está na sua rede, verifique se o roteador não bloqueia respostas de DNS que apontam para endereços locais.',
  'plex.search': 'Buscar na biblioteca',
  'plex.viaLan': 'Pela rede local — mantenha esta aba aberta até a transferência terminar.',
  'plex.viaInternet': 'Pela internet — o servidor busca sozinho, você pode fechar a aba.',
  'plex.noDownloads': 'O Plex recusou o arquivo original. Habilite "Allow Downloads" para este usuário nas configurações do servidor.',
```

- [ ] **Step 5: Mount it**

Em `web/src/plugins/PluginsPanel.tsx`, na etapa `list`, acima da lista de plugins:

```tsx
                <PlexSection onPlay={onPlexPlay} />
                <h2>{t('plugins.title')}</h2>
```

O Plex fica numa seção própria, acima e visivelmente separada. Ele não é um plugin, e listá-lo junto ensinaria a coisa errada para quem vier escrever um.

`onPlexPlay` vem de fora, porque o que fazer com a escolha depende de onde o painel está aberto. Em `Home.tsx` é criar a sala; em `Room.tsx` é trocar a fonte:

```tsx
// Home.tsx
  const onPlexPlay = async (open: PlexOpen) => {
    setPluginsOpen(false)
    if (open.kind === 'server-pull') {
      const created = await createRoomAndIngestUrl(open.url, open.fileName, open.size, draftNickname.trim())
      navigate(`/room/${created.roomID}`)
      return
    }
    const created = await createRoom(open.fileName, draftNickname.trim())
    startRemoteTransfer(created.id, created.uploadEndpoint, streamStartBytes(created), 0, open.source)
    navigate(`/room/${created.id}`)
  }
```

```tsx
// Room.tsx
  const onPlexPlay = (open: PlexOpen) => {
    setPluginsOpen(false)
    void swapSource(async () => {
      const next = await changeRoomSource(room.id, sync.memberId, sync.capability, 'upload', open.fileName)
      if (open.kind === 'server-pull') {
        await startUrlTransfer(room.id, open.url, open.fileName, open.size)
        return
      }
      startRemoteTransfer(room.id, next.uploadEndpoint, next.streamStartBytes, next.mediaGeneration, open.source)
    })
  }
```

Confira `createRoom` e `streamStartBytes` em `web/src/upload.ts` antes de escrever o ramo da Home: se `createRoom` não for exportado, exporte-o ou acrescente um `createRoomAndPump` ao lado de `createRoomAndIngestUrl`, seguindo a forma dos outros.

- [ ] **Step 6: Run everything and commit**

Run: `cd web && npm run test && npx tsc -b && npm run lint`
Expected: verde.

```bash
git add web/src/plex web/src/plugins/PluginsPanel.tsx web/src/pages/Home.tsx web/src/pages/Room.tsx \
  web/src/i18n/pt-BR.ts web/src/i18n/en.ts web/src/theme.css
git commit -m "feat: play a title from a plex server"
```

---

## Notas de revisão

Três coisas que quem executar vai encontrar e que estão aqui de propósito:

1. **A Task 8 deixa `fetchStreams` e `ADDON_BASE` vivos de propósito.** Eles só morrem na Task 9. Se você chegar na Task 9 e encontrá-los já removidos, alguém quebrou a Task 8 pela metade.
2. **`web/src/plugins/worker.ts` (Task 4) não tem teste automatizado.** jsdom não tem `Worker`. A verificação é manual, os quatro casos do passo 5 são o teste, e os dois últimos — a fuga pelo protótipo e o worker aninhado — são a razão de a task existir na forma em que está. Não pule pensando que a suíte cobre.
3. **A Task 4 e a Task 16 são duas metades de uma coisa só.** O bootstrap do worker remove nomes; o cabeçalho `Content-Security-Policy` da Task 16 é o que fecha o `import()` remoto, que de dentro do worker nada consegue remover. Fazer só uma das duas deixa o isolamento pela metade sem que nada falhe visivelmente.
4. **A Task 19 mexe no caminho de torrent.** Ela generaliza `startTorrentTransfer` em `startRemoteTransfer` e deixa um adaptador no lugar. Rode a suíte inteira, não só os arquivos novos.
5. **As Tasks 17 a 20 dependem do polyfill de `webcrypto` que a Task 5 acrescenta ao `setup.ts`** — `crypto.randomUUID` também não existe no jsdom sem ele.
