import legacy from '@vitejs/plugin-legacy'
import react from '@vitejs/plugin-react'
import presetEnv from 'postcss-preset-env'
import { defineConfig, mergeConfig } from 'vite'
import site from './vite.config.ts'

// /tv on its own, for TVs: webOS 4 runs Chromium 53 and Tizen 5 runs 63, and
// both load it as a classic script (SystemJS), never as a module. Served
// from /tv-app/, so it never mixes with the site's chunks.
const CHROME = 53

export default mergeConfig(
  { worker: site.worker },
  defineConfig({
    base: '/tv-app/',
    // The site's public files are served from the root already.
    publicDir: false,
    plugins: [
      react(),
      legacy({ targets: [`chrome >= ${CHROME}`], polyfills: true, renderModernChunks: false }),
    ],
    css: {
      // inset becomes its four sides and gap gets grid-gap beside it; flex
      // gap has no fallback, so the TV's own screens space with margins.
      postcss: { plugins: [presetEnv({ browsers: [`chrome >= ${CHROME}`], stage: 2, features: { 'nesting-rules': true } })] },
    },
    build: {
      outDir: 'dist/tv-app',
      emptyOutDir: true,
      cssTarget: `chrome${CHROME}`,
      rolldownOptions: { input: 'tv.html' },
    },
  }),
)
