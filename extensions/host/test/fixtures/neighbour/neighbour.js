// Another extension with a secret of its own, that the hostile one must not reach.
localStorage.setItem('segredo', 'token-da-vizinha')
window.__stored = localStorage.getItem('segredo')
