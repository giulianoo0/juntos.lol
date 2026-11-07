import { installJuntos } from './sdk'

declare const JUNTOS_ORIGINS: string[]

if (!('juntos' in window)) {
  Object.defineProperty(window, 'juntos', { value: Object.freeze(installJuntos(window, JUNTOS_ORIGINS)) })
}
