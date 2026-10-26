import { Compass, Film, Magnet, MonitorUp } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ShareSource } from '../model'
import { YoutubeGlyph } from '../../ui/YoutubeGlyph'
import type { RoomStrings } from './strings'

export const sourceIcon: Record<ShareSource, ReactNode> = {
  screen: <MonitorUp size={16} />,
  file: <Film size={16} />,
  torrent: <Magnet size={16} />,
  youtube: <YoutubeGlyph size={16} />,
  catalog: <Compass size={16} />,
}

export const sourceLabel = (strings: RoomStrings): Record<ShareSource, string> => ({
  screen: strings.sourceScreen,
  file: strings.sourceFile,
  torrent: strings.sourceTorrent,
  youtube: strings.sourceYoutube,
  catalog: strings.sourceCatalog,
})
