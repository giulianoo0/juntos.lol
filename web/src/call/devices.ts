/** The microphones, cameras and speakers this browser lists, each kind on its own. */
export interface DeviceLists {
  mics: MediaDeviceInfo[]
  cams: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
}

/** Which device of each kind the member picked; unset means the browser's default. */
export interface DevicePrefs {
  mic?: string
  cam?: string
  speaker?: string
}

const PREFS_KEY = 'ss.call-devices.v1'

/**
 * Before permission is granted the browser lists each kind once with no id;
 * those placeholders cannot be picked, so they are left out.
 */
export function groupDevices(devices: MediaDeviceInfo[]): DeviceLists {
  const usable = devices.filter((device) => device.deviceId !== '')
  return {
    mics: usable.filter((device) => device.kind === 'audioinput'),
    cams: usable.filter((device) => device.kind === 'videoinput'),
    speakers: usable.filter((device) => device.kind === 'audiooutput'),
  }
}

/** The saved device while it is still plugged in, else the first one listed. */
export function chooseDevice(devices: MediaDeviceInfo[], saved: string | undefined): string | undefined {
  if (saved && devices.some((device) => device.deviceId === saved)) return saved
  return devices[0]?.deviceId
}

export function loadDevicePrefs(): DevicePrefs {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
    return typeof stored === 'object' && stored !== null ? stored as DevicePrefs : {}
  } catch {
    return {}
  }
}

export function saveDevicePrefs(prefs: DevicePrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch { /* the choice just is not remembered */ }
}
