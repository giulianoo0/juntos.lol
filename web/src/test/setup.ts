import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
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

// jsdom lacks ResizeObserver; the carousels only need it to exist to mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!('ResizeObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: ResizeObserverStub })
}

class IntersectionObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return [] }
}
if (!('IntersectionObserver' in globalThis)) {
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: IntersectionObserverStub })
}
// jsdom never upgrades NumberFlow's custom element, so on update it reaches
// for methods that are not there and takes its subtree down with it.
vi.mock('@number-flow/react', () => ({
  __esModule: true,
  default: ({ value, prefix = '', suffix = '', format }: { value: number; prefix?: string; suffix?: string; format?: Intl.NumberFormatOptions }) =>
    `${prefix}${format ? new Intl.NumberFormat('en-US', format).format(value) : value}${suffix}`,
  NumberFlowGroup: ({ children }: { children: unknown }) => children,
}))
