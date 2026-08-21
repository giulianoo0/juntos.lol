import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

afterEach(cleanup)

const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    key: (index: number) => [...storage.keys()][index] ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, String(value)),
    get length() { return storage.size },
  },
})

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

// NumberFlow animates digits through a custom element with a shadow root.
// jsdom never upgrades it, so on update the component reaches for methods that
// are not there and takes its whole subtree down with it. The digits are
// presentation; tests care about the number, so they get the number.
vi.mock('@number-flow/react', () => ({
  __esModule: true,
  default: ({ value, prefix = '', suffix = '' }: { value: number; prefix?: string; suffix?: string }) =>
    `${prefix}${value}${suffix}`,
}))
