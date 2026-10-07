import { expect, it } from 'vitest'
import { audioLocked, installAudioUnlock } from './audioUnlock'

class HeldContext extends EventTarget {
  state: AudioContextState = 'suspended'
  resume() {
    this.state = 'running'
    this.dispatchEvent(new Event('statechange'))
    return Promise.resolve()
  }
}

it('resumes a context the page made without a gesture on the next tap', async () => {
  window.AudioContext = HeldContext as unknown as typeof AudioContext
  installAudioUnlock()

  new window.AudioContext()
  expect(audioLocked()).toBe(true)

  document.dispatchEvent(new Event('pointerdown'))
  await Promise.resolve()
  expect(audioLocked()).toBe(false)
})
