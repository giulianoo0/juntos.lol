import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: {
    // The remux worker is a module worker that splits chunks; Vite's build
    // default is 'iife', which cannot.
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test-setup/node-crypto.ts', './src/test/setup.ts'],
    css: true,
    environmentOptions: { jsdom: { url: 'http://localhost/' } },
  },
})
