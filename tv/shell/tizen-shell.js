// Casca do app Samsung. Página hospedada não tem as APIs do Tizen ("For security
// reasons, Tizen APIs are not supported in hosted applications",
// https://developer.samsung.com/smarttv/develop/faq/hosted-applications.html),
// então a casca é local: registra as teclas de mídia, abre /tv num iframe e fecha
// o app quando a página pede com postMessage {type: "juntos-tv:exit"}.
;(function (root) {
  var MEDIA_KEYS = [
    "MediaPlayPause",
    "MediaPlay",
    "MediaPause",
    "MediaStop",
    "MediaFastForward",
    "MediaRewind",
    "ColorF0Red",
    "ColorF1Green",
    "ColorF2Yellow",
    "ColorF3Blue",
    "Info",
    "Tools",
  ]
  var BACK = 10009

  function registerKeys(tizen) {
    if (!tizen || !tizen.tvinputdevice) return []
    var supported = {}
    tizen.tvinputdevice.getSupportedKeys().forEach(function (k) {
      supported[k.name] = true
    })
    return MEDIA_KEYS.filter(function (name) {
      if (!supported[name]) return false
      try {
        tizen.tvinputdevice.registerKey(name)
        return true
      } catch (e) {
        return false
      }
    })
  }

  function start(win, url) {
    var origin = new win.URL(url).origin
    var keys = registerKeys(win.tizen)
    var frame = win.document.getElementById("app")

    function exit() {
      try {
        win.tizen.application.getCurrentApplication().exit()
      } catch (e) {
        win.close()
      }
    }

    frame.addEventListener("load", function () {
      win.document.documentElement.classList.add("ready")
      frame.focus()
      frame.contentWindow.postMessage({ type: "juntos-tv:shell", platform: "tizen", keys: keys }, origin)
    })
    win.addEventListener("message", function (e) {
      if (e.origin === origin && e.data && e.data.type === "juntos-tv:exit") exit()
    })
    win.addEventListener("keydown", function (e) {
      if (e.keyCode === BACK) exit()
    })
    frame.src = url
  }

  root.juntosTvShell = { start: start }
})(this)
