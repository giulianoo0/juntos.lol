import { KINDS } from "./kinds";
import { MASCOT_ACCESSORIES, MASCOT_KINDS, type MascotAccessory, type MascotKind } from "./types";

export type AvatarSpec = { kind: MascotKind; color?: string; accessory: MascotAccessory };

const isKind = (value: string): value is MascotKind => (MASCOT_KINDS as readonly string[]).includes(value);
const isAccessory = (value: string): value is MascotAccessory => MASCOT_ACCESSORIES.some((a) => a.id === value);

/** `fox.bowtie`, `cat-preto.beanie`, or just `owl` with nothing on. */
export function serializeAvatar({ kind, color, accessory }: AvatarSpec): string {
  const head = color && KINDS[kind].colors?.[color] ? `${kind}-${color}` : kind;
  return accessory === "none" ? head : `${head}.${accessory}`;
}

/** Null for anything `serializeAvatar` would not write. */
export function parseAvatar(text: string): AvatarSpec | null {
  const dot = text.indexOf(".");
  const head = dot < 0 ? text : text.slice(0, dot);
  const accessory = dot < 0 ? "none" : text.slice(dot + 1);
  const [kind, color, ...rest] = head.split("-");
  if (rest.length || !kind || !isKind(kind) || !isAccessory(accessory) || (accessory === "none" && dot >= 0)) return null;
  if (color === undefined) return { kind, accessory };
  return KINDS[kind].colors?.[color] ? { kind, color, accessory } : null;
}
