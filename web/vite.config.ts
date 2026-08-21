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
    // A stable prefix so the server can recognise this one response and serve
    // it with a Content-Security-Policy the rest of the app must not have.
    rollupOptions: { output: { entryFileNames: 'assets/plugin-worker-[hash].js' } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: true,
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
  },
})
