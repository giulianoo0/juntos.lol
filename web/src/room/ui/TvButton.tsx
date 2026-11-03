import { Film, MonitorOff, MonitorX, Plus, Tv, Volume2, VolumeX } from 'lucide-react'
import { useState, type CSSProperties } from 'react'
import { toast } from 'sonner'
import type { Mix, RoomTv, RoomTvDevice } from '../model'
import { LinkTvDialog } from '../../tvlink/LinkTvDialog'
import { levelIn, onlyMedia, withLevel } from '../../tvlink/mix'
import { DiscordGlyph } from '../../ui/DiscordGlyph'
import { IconPill } from '../../ui/IconPill'
import { Modal } from '../../ui/Modal'
import { Pill, PillLink } from '../../ui/Pill'
import { SpringPopover, SpringRow, SpringRule } from '../../ui/SpringPopover'
import { Spinner } from '../../ui/Spinner'
import { Tip } from '../../ui/Tip'
import { useRoomUi } from './context'
import { Face } from './Face'
import { fill, type RoomStrings } from './strings'
import styles from './TvButton.module.css'

const castError = (strings: RoomStrings, code: string) =>
  code === 'tv_offline' ? strings.tvOffline : code === 'not_in_room' ? strings.tvNotInRoom : strings.tvFailed

/**
 * "Espelhar na TV" in the dock. Without an account it only says one is
 * needed; with no TV it opens Vincular TV; with TVs, the menu to pick one;
 * while one plays this room, that menu is its sound: the stage's and each
 * person's, as the TV plays them.
 */
export function TvButton({ tv }: { tv: RoomTv }) {
  const { strings } = useRoomUi()
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [linking, setLinking] = useState(false)
  const playing = tv.devices?.find((device) => device.here) ?? null

  if (!tv.signedIn) {
    return (
      <>
        <IconPill label={strings.mirror} icon={<Tv size={18} />} className={styles.locked} data-locked="" onClick={() => setAsking(true)} />
        <Modal open={asking} onOpenChange={setAsking} title={strings.mirror} closeLabel={strings.close}>
          <div className={styles.ask}>
            <p className={styles.askText}>{strings.tvNeedsAccount}</p>
            <PillLink tone="brand" size="lg" block icon={<DiscordGlyph size={18} />} href={tv.loginUrl}>{strings.withDiscord}</PillLink>
          </div>
        </Modal>
      </>
    )
  }

  const linkDialog = <LinkTvDialog open={linking} onOpenChange={setLinking} link={tv.link} />
  if (tv.devices?.length === 0) {
    return (
      <>
        <IconPill label={strings.mirror} icon={<Tv size={18} />} onClick={() => setLinking(true)} />
        {linkDialog}
      </>
    )
  }

  const change = (next: boolean) => {
    setOpen(next)
    tv.watch(next)
  }
  const cast = (device: RoomTvDevice) => {
    tv.cast(device.id).catch((failure: Error) => toast(castError(strings, failure.message)))
  }

  return (
    <>
      <SpringPopover
        triggerRender={<IconPill label={strings.mirror} icon={<Tv size={18} />} active={playing !== null} />}
        triggerLabel={strings.mirror}
        title={playing ? playing.name : strings.mirror}
        side="top"
        align="center"
        width={playing ? '20rem' : '16rem'}
        open={open}
        onOpenChange={change}
      >
        {({ close }) => playing ? (
          <MixPanel device={playing} tv={tv} onStop={() => { close(); tv.stop(playing.id) }} />
        ) : tv.devices === null ? (
          <div className={styles.loading}><Spinner /></div>
        ) : (
          <div role="menu" aria-label={strings.mirror}>
            {tv.devices.map((device) => (
              <SpringRow
                key={device.id}
                icon={device.online ? <Tv size={16} /> : <MonitorOff size={16} />}
                label={device.name}
                disabled={!device.online}
                onSelect={() => { close(); cast(device) }}
              />
            ))}
            <SpringRule />
            <SpringRow icon={<Plus size={16} />} label={strings.linkTv} onSelect={() => { close(); setLinking(true) }} />
          </div>
        )}
      </SpringPopover>
      {linkDialog}
    </>
  )
}

function MixPanel({ device, tv, onStop }: { device: RoomTvDevice; tv: RoomTv; onStop: () => void }) {
  const { vm, strings } = useRoomUi()
  const owner = vm.selfId
  const set = (mix: Mix) => tv.setMix(device.id, mix)
  const level = (id: string) => levelIn(device.mix, id, owner)
  const allQuiet = vm.people.every((person) => level(person.id) === 0)
  return (
    <div className={styles.mix}>
      <div className={styles.line}>
        <Tip label={strings.mediaVolume}><span className={styles.mark} aria-hidden="true"><Film size={16} /></span></Tip>
        <Level label={strings.mediaVolume} value={device.mix.media} onChange={(media) => set({ ...device.mix, media })} />
      </div>
      {vm.people.map((person) => {
        const value = level(person.id)
        return (
          <div key={person.id} className={styles.line}>
            <span className={styles.face} aria-hidden="true"><Face id={person.id} avatar={person.avatar} size={28} /></span>
            <span className={styles.who}>
              <span className={styles.name}>{person.name}</span>
              <Level label={fill(strings.volumeOf, { name: person.name })} value={value} onChange={(next) => set(withLevel(device.mix, person.id, next, owner))} />
            </span>
            <IconPill
              size="sm"
              label={fill(value === 0 ? strings.tvUnmute : strings.tvMute, { name: person.name })}
              icon={value === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
              onClick={() => set(withLevel(device.mix, person.id, value === 0 ? 1 : 0, owner))}
            />
          </div>
        )
      })}
      <Pill tone="soft" size="md" block disabled={allQuiet} onClick={() => set(onlyMedia(device.mix, vm.people.map((person) => person.id)))}>{strings.onlyMedia}</Pill>
      <SpringRule />
      <div role="menu" aria-label={device.name}>
        <SpringRow icon={<MonitorX size={16} />} label={strings.mirrorStop} tone="danger" onSelect={onStop} />
      </div>
    </div>
  )
}

/** A horizontal 0..1 slider: the browser's range, drawn as a filled track. */
function Level({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <input
      className={styles.level}
      style={{ '--level': `${Math.round(value * 100)}%` } as CSSProperties}
      type="range"
      min="0"
      max="1"
      step="0.01"
      aria-label={label}
      aria-valuetext={`${Math.round(value * 100)}%`}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}
