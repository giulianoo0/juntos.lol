// `/tv?mock` in dev walks the page against a pretend server; production never carries it.
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('mock')) {
  const { installTvMock } = await import('./devMock')
  installTvMock()
}

export { TvApp } from './TvApp'
