import { getCachedJLocalCapabilities } from './capabilities'
import { SCREEN_QUALITIES, type ScreenQualityId } from '../screenshare'

/** Presets the app can honour: the browser's list minus auto, capped by the app's ceilings. */
export function jlocalQualities(): ScreenQualityId[] {
  const caps = getCachedJLocalCapabilities()
  const maxWidth = caps?.screen.maxWidth ?? 3840
  const maxFps = caps?.screen.maxFps ?? 60
  const allowed = SCREEN_QUALITIES.filter((q) => q.width !== undefined && q.width <= maxWidth && (q.frameRate ?? 30) <= maxFps).map((q) => q.id)
  return allowed.length > 0 ? allowed : ['1080p30']
}
