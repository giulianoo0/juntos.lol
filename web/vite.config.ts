import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: {
    // The plugin worker dynamically imports the plugin's own module, and a
    // classic worker cannot do that. Vite's build default is 'iife', so
    // without this the sandbox works in `npm run dev` and breaks after
    // deploy — the worst shape a bug can have.
    format: 'es',
    // Its own directory, so the server can match a path rather than a name and
    // give this one response a Content-Security-Policy the rest of the app
    // must not have. All three patterns are pinned on purpose: with only
    // entryFileNames set, the first `import` added to worker.ts would split a
    // shared chunk out to the default `assets/[name]-[hash].js`, which stops
    // matching, and the worker would then load code with no policy at all —
    // a security downgrade caused by adding an import.
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/plugin-worker/[hash].js',
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
