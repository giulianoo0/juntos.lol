import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"

const source = readFileSync(new URL("./tizen-shell.js", import.meta.url), "utf8")
const URL_TV = "https://juntos.lol/tv"

function fakeTv({ tizen = true, supported } = {}) {
  const listeners = {}
  const frameListeners = {}
  const posted = []
  const calls = { registered: [], exit: 0, focus: 0, close: 0 }
  const frame = {
    src: "",
    addEventListener: (type, fn) => (frameListeners[type] = fn),
    focus: () => calls.focus++,
    contentWindow: {
      // JSON tira os protótipos do contexto do vm para o deepEqual comparar só a forma.
      postMessage: (data, origin) => posted.push({ data: JSON.parse(JSON.stringify(data)), origin }),
    },
  }
  const win = {
    URL,
    addEventListener: (type, fn) => (listeners[type] = fn),
    close: () => calls.close++,
    document: {
      getElementById: (id) => (id === "app" ? frame : null),
      documentElement: { classList: { add: (c) => (win.ready = c) } },
    },
  }
  if (tizen) {
    const names = supported ?? ["MediaPlayPause", "MediaFastForward", "MediaRewind", "ColorF0Red", "VolumeUp"]
    win.tizen = {
      tvinputdevice: {
        getSupportedKeys: () => names.map((name) => ({ name })),
        registerKey: (name) => {
          if (name === "ColorF0Red") throw new Error("NotSupportedError")
          calls.registered.push(name)
        },
      },
      application: { getCurrentApplication: () => ({ exit: () => calls.exit++ }) },
    }
  }
  const ctx = vm.createContext(win)
  vm.runInContext(source, ctx)
  win.juntosTvShell.start(win, URL_TV)
  return {
    win,
    frame,
    posted,
    calls,
    load: () => frameListeners.load(),
    message: (origin, data) => listeners.message({ origin, data }),
    key: (keyCode) => listeners.keydown({ keyCode }),
  }
}

test("abre a página da TV no iframe", () => {
  const tv = fakeTv()
  assert.equal(tv.frame.src, URL_TV)
})

test("registra só as teclas de mídia que a TV tem, sem parar no erro de uma", () => {
  const tv = fakeTv()
  assert.deepEqual(tv.calls.registered, ["MediaPlayPause", "MediaFastForward", "MediaRewind"])
})

test("ao carregar, foca o iframe e conta à página quais teclas foram registradas", () => {
  const tv = fakeTv()
  tv.load()
  assert.equal(tv.calls.focus, 1)
  assert.deepEqual(tv.posted, [
    {
      data: { type: "juntos-tv:shell", platform: "tizen", keys: ["MediaPlayPause", "MediaFastForward", "MediaRewind"] },
      origin: "https://juntos.lol",
    },
  ])
})

test("pedido de saída da página fecha o app", () => {
  const tv = fakeTv()
  tv.message("https://juntos.lol", { type: "juntos-tv:exit" })
  assert.equal(tv.calls.exit, 1)
})

test("pedido de saída de outra origem é ignorado", () => {
  const tv = fakeTv()
  tv.message("https://evil.example", { type: "juntos-tv:exit" })
  assert.equal(tv.calls.exit, 0)
})

test("Voltar com o foco na casca (página não carregou) fecha o app", () => {
  const tv = fakeTv()
  tv.key(10009)
  assert.equal(tv.calls.exit, 1)
})

test("fora da TV não quebra e sai com window.close", () => {
  const tv = fakeTv({ tizen: false })
  tv.load()
  assert.deepEqual(tv.posted[0].data.keys, [])
  tv.message("https://juntos.lol", { type: "juntos-tv:exit" })
  assert.equal(tv.calls.close, 1)
})
