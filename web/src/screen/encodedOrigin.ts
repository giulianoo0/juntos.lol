import { screenQuality } from '../screenshare'
import { isJLocalCaptureAvailable } from '../jlocal/capabilities'
import { startH264Feed, systemAudioTrack, type H264Feed, type H264FeedOptions, type SystemAudio } from '../jlocal/h264Feed'
import { applySoundChoice, getSoundChoice } from '../jlocal/soundChoice'
import { appAudioTrack, appCanCapture, startAppFeed, type AppFeed } from '../desktop/screen'
import type { JlocalPick } from './useScreenShare'

/** A share's soundtrack; one that can drop apps live takes the new list here. */
export type OriginSound = SystemAudio & { setMuted?(muted: readonly string[]): void }

/**
 * Where an already-encoded share comes from: the jlocal companion over
 * loopback or the desktop app the page runs in. Both hand over the same
 * H.264 frames; they differ in how a live share moves to another surface.
 */
export interface EncodedOrigin {
  kind: 'jlocal' | 'app'
  start(pick: JlocalPick): Promise<H264Feed>
  /**
   * The live feed moved to the pick. The app moves its own capture and
   * answers with the same feed; jlocal answers with a new one, and the
   * caller ends the old one once the publisher has moved over.
   */
  move(feed: H264Feed, pick: JlocalPick): Promise<H264Feed>
  sound(): OriginSound | null
}

export function feedOptions(pick: JlocalPick): H264FeedOptions {
  const quality = screenQuality(pick.quality)
  return {
    target: pick.target,
    width: quality.width ?? 1920,
    height: quality.height ?? 1080,
    fps: quality.frameRate ?? 30,
    bitrate: quality.maxBitrate,
  }
}

const jlocalOrigin: EncodedOrigin = {
  kind: 'jlocal',
  start(pick) {
    // The app is told which sounds go out before the first frame leaves.
    applySoundChoice()
    return startH264Feed(feedOptions(pick))
  },
  move: (_feed, pick) => startH264Feed(feedOptions(pick)),
  sound: () => systemAudioTrack(),
}

const appOrigin: EncodedOrigin = {
  kind: 'app',
  start: (pick) => startAppFeed(feedOptions(pick)),
  async move(feed, pick) {
    await (feed as AppFeed).retarget(feedOptions(pick))
    return feed
  },
  sound: () => appAudioTrack(getSoundChoice().muted),
}

/** The app wins when it captures itself: it is the page's own host, jlocal a guest. */
export function encodedOrigin(): EncodedOrigin {
  return appCanCapture() ? appOrigin : jlocalOrigin
}

/** Which picker the share button opens; null is the browser's own. Synchronous, for a click. */
export function encodedPicker(): EncodedOrigin['kind'] | null {
  if (appCanCapture()) return 'app'
  return isJLocalCaptureAvailable() ? 'jlocal' : null
}
