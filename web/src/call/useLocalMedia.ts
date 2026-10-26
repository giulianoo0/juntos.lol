import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chooseDevice, groupDevices, loadDevicePrefs, saveDevicePrefs, type DeviceLists, type DevicePrefs } from './devices'
import { openCam, openMic } from './media'

export type DeviceKind = keyof DevicePrefs

/** Why a microphone or camera did not open. */
export type LocalMediaError = 'denied' | 'unavailable'

export interface LocalMedia {
  mic: boolean
  cam: boolean
  micTrack: MediaStreamTrack | null
  camTrack: MediaStreamTrack | null
  /** Turns the microphone on or off; resolves once the device answered. */
  setMic(on: boolean): Promise<void>
  setCam(on: boolean): Promise<void>
  devices: DeviceLists
  selected: DevicePrefs
  /** Picks another device, remembers it, and moves a live track onto it. */
  setDevice(kind: DeviceKind, deviceId: string): void
  /** My camera, for a mirrored `<video muted>`; null while it is off. */
  previewStream: MediaStream | null
  error: LocalMediaError | null
}

const NO_DEVICES: DeviceLists = { mics: [], cams: [], speakers: [] }

function mediaError(failure: unknown): LocalMediaError {
  return failure instanceof DOMException && (failure.name === 'NotAllowedError' || failure.name === 'SecurityError') ? 'denied' : 'unavailable'
}

/**
 * This browser's microphone and camera, on their own: the entry screen uses
 * it for the preview before anyone is in the room, and the call builds on it.
 * A device that is off is closed, so the browser's recording light goes out.
 */
export function useLocalMedia(initial: { mic?: boolean; cam?: boolean } = {}): LocalMedia {
  const [micTrack, setMicTrack] = useState<MediaStreamTrack | null>(null)
  const [camTrack, setCamTrack] = useState<MediaStreamTrack | null>(null)
  const [devices, setDevices] = useState<DeviceLists>(NO_DEVICES)
  const [selected, setSelected] = useState<DevicePrefs>(() => loadDevicePrefs())
  const [error, setError] = useState<LocalMediaError | null>(null)
  const tracksRef = useRef<{ mic: MediaStreamTrack | null; cam: MediaStreamTrack | null }>({ mic: null, cam: null })
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  /** Bumped on every switch so an open that finishes after a newer one is thrown away. */
  const turnRef = useRef({ mic: 0, cam: 0 })

  const refreshDevices = useCallback(async () => {
    const listed = await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])
    if (listed) setDevices(groupDevices(listed))
  }, [])

  useEffect(() => {
    void refreshDevices()
    const media = navigator.mediaDevices
    media?.addEventListener?.('devicechange', refreshDevices)
    return () => media?.removeEventListener?.('devicechange', refreshDevices)
  }, [refreshDevices])

  const put = useCallback((kind: 'mic' | 'cam', track: MediaStreamTrack | null) => {
    tracksRef.current[kind]?.stop()
    tracksRef.current[kind] = track
    if (kind === 'mic') setMicTrack(track)
    else setCamTrack(track)
    // A device unplugged mid-call ends its track; the switch goes off with it.
    track?.addEventListener('ended', () => {
      if (tracksRef.current[kind] !== track) return
      tracksRef.current[kind] = null
      if (kind === 'mic') setMicTrack(null)
      else setCamTrack(null)
    }, { once: true })
  }, [])

  const turn = useCallback(async (kind: 'mic' | 'cam', on: boolean) => {
    const ticket = ++turnRef.current[kind]
    if (!on) { put(kind, null); return }
    const deviceId = chooseDevice(kind === 'mic' ? devices.mics : devices.cams, selectedRef.current[kind])
    try {
      const track = await (kind === 'mic' ? openMic(deviceId) : openCam(deviceId))
      if (turnRef.current[kind] !== ticket) { track.stop(); return }
      setError(null)
      put(kind, track)
      // Labels and ids only show up once permission is granted.
      void refreshDevices()
    } catch (failure) {
      if (turnRef.current[kind] !== ticket) return
      setError(mediaError(failure))
      put(kind, null)
    }
  }, [devices, put, refreshDevices])

  const setMic = useCallback((on: boolean) => turn('mic', on), [turn])
  const setCam = useCallback((on: boolean) => turn('cam', on), [turn])

  const setDevice = useCallback((kind: DeviceKind, deviceId: string) => {
    const next = { ...selectedRef.current, [kind]: deviceId }
    selectedRef.current = next
    setSelected(next)
    saveDevicePrefs(next)
    if (kind !== 'speaker' && tracksRef.current[kind]) void turn(kind, true)
  }, [turn])

  const initialRef = useRef(initial)
  useEffect(() => {
    if (initialRef.current.mic) void turn('mic', true)
    if (initialRef.current.cam) void turn('cam', true)
    // Only the first render's wish counts; later ones go through setMic/setCam.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    tracksRef.current.mic?.stop()
    tracksRef.current.cam?.stop()
  }, [])

  const previewStream = useMemo(() => (camTrack ? new MediaStream([camTrack]) : null), [camTrack])

  return {
    mic: micTrack !== null,
    cam: camTrack !== null,
    micTrack,
    camTrack,
    setMic,
    setCam,
    devices,
    selected,
    setDevice,
    previewStream,
    error,
  }
}
