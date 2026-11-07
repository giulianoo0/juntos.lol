// Opened by the extension: tries to reach juntos through its opener.
window.__results = {}
const r = window.__results
r.hasOpener = window.opener !== null
try {
  window.opener.parent.postMessage({ juntos: 1, type: 'play', title: 'do popup', ref: '1', source: { kind: 'hls', url: 'https://cdn.media.example/ep/ok.m3u8' } }, '*')
  r.postedToJuntos = true
} catch (e) {
  r.postedToJuntos = String(e)
}
try {
  window.opener.top.location = 'http://127.0.0.1:8096/?pwned=popup'
  r.navigatedTop = 'tried'
} catch (e) {
  r.navigatedTop = String(e)
}
r.done = true
