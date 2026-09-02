import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: {
    // The plugin worker dynamically imports the plugin's module, which a
    // classic worker cannot do; Vite's build default is 'iife'.
    format: 'es',
    // Its own directory, so the server can match a path and give this one
    // response its own Content-Security-Policy. All three patterns are pinned:
    // otherwise a new import splits a chunk out to the default path, which the
    // server does not match, and the worker loads with no policy at all.
    rolldownOptions: {
      output: {
        // The remux and subtitle workers must be able to fetch, so their
        // entries live on a path the plugin-worker CSP does not cover.
        entryFileNames: (chunk) => chunk.name === 'remuxWorker' || chunk.name === 'subtitleWorker'
          ? 'assets/media-worker/[hash].js'
          : 'assets/plugin-worker/[hash].js',
        chunkFileNames: 'assets/plugin-worker/[hash].js',
        assetFileNames: 'assets/plugin-worker/[hash][extname]',
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test-setup/node-crypto.ts', './src/test/setup.ts'],
    css: true,
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
  },
})
