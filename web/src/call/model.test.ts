import { beforeEach, describe, expect, it } from 'vitest'
import { SpeakingDetector } from './speaking'
import { chooseDevice, groupDevices, loadDevicePrefs, saveDevicePrefs } from './devices'
import { hearable, viewable } from './plan'

describe('SpeakingDetector', () => {
  it('lights up at once on a loud level and holds through short pauses', () => {
    const detector = new SpeakingDetector()
    expect(detector.update(0.001, 0)).toBe(false)
    expect(detector.update(0.08, 20)).toBe(true)
    // A breath between words is not the end of speech.
    expect(detector.update(0.001, 200)).toBe(true)
    expect(detector.update(0.001, 380)).toBe(true)
    expect(detector.update(0.001, 520)).toBe(false)
  })

  it('ignores a level that only creeps above the noise floor', () => {
    const detector = new SpeakingDetector()
    for (let at = 0; at < 1000; at += 20) expect(detector.update(0.01, at)).toBe(false)
  })

  it('keeps speaking while the level stays between the two thresholds', () => {
    const detector = new SpeakingDetector()
    detector.update(0.08, 0)
    for (let at = 20; at < 1000; at += 20) expect(detector.update(0.03, at)).toBe(true)
  })
})

const device = (kind: MediaDeviceKind, deviceId: string, label = deviceId) =>
  ({ kind, deviceId, label, groupId: 'g', toJSON: () => ({}) }) as MediaDeviceInfo

describe('devices', () => {
  beforeEach(() => localStorage.clear())

  it('groups what the browser lists by kind and drops the unnamed duplicates', () => {
    const grouped = groupDevices([
      device('audioinput', 'default', 'Padrão'),
      device('audioinput', 'mic-1', 'USB'),
      device('videoinput', 'cam-1', 'FaceTime'),
      device('audiooutput', 'out-1', 'Fones'),
      device('audioinput', ''),
    ])
    expect(grouped.mics.map((d) => d.deviceId)).toEqual(['default', 'mic-1'])
    expect(grouped.cams.map((d) => d.deviceId)).toEqual(['cam-1'])
    expect(grouped.speakers.map((d) => d.deviceId)).toEqual(['out-1'])
  })

  it('keeps the saved choice while the device is plugged in, and falls back otherwise', () => {
    const mics = [device('audioinput', 'default'), device('audioinput', 'mic-1')]
    expect(chooseDevice(mics, 'mic-1')).toBe('mic-1')
    expect(chooseDevice(mics, 'gone')).toBe('default')
    expect(chooseDevice([], 'mic-1')).toBeUndefined()
  })

  it('remembers the choice across visits', () => {
    expect(loadDevicePrefs()).toEqual({})
    saveDevicePrefs({ mic: 'mic-1', cam: 'cam-1' })
    expect(loadDevicePrefs()).toEqual({ mic: 'mic-1', cam: 'cam-1' })
  })
})

describe('plan', () => {
  const members = [
    { id: 'm1', mic: true, cam: true },
    { id: 'm2', mic: true, cam: false },
    { id: 'm3', mic: false, cam: true, hostMuted: true },
    { id: 'm4', mic: false, cam: false, hostCamOff: true, hostMuted: true },
  ]

  it('hears everyone else whose microphone is on', () => {
    expect(hearable(members, 'm1')).toEqual(['m2'])
    expect(hearable(members, 'm9')).toEqual(['m1', 'm2'])
  })

  it('sees a camera only while it is on and the host has not turned it off', () => {
    expect(viewable(members, 'm1')).toBe(true)
    expect(viewable(members, 'm2')).toBe(false)
    expect(viewable(members, 'm3')).toBe(true)
    expect(viewable(members, 'm4')).toBe(false)
    expect(viewable(members, 'm9')).toBe(false)
  })
})
