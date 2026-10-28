/** A palette slot of the kind ("body", "inner", "tip", "accent", "eye") or a literal color. */
export type Paint = string;

export type Part = { d: string; fill?: Paint; stroke?: Paint; width?: number; opacity?: number };

/** Drawn on the left and mirrored; turns around `pivot` with the ear spring, scaled by `sway` (0 holds it still). */
export type EarArt = {
  path: string;
  inner?: string;
  tip?: string;
  fill?: Paint;
  pivot: readonly [number, number];
  sway?: number;
  /** Antennae: they go under a hat instead of poking through it. */
  antenna?: boolean;
};

/** One piece on top of the head (antenna, leaf, flame, cap); `front` draws it over the body, `keep` leaves it under a hat. */
export type TopArt = {
  path: string;
  fill?: Paint;
  parts?: readonly Part[];
  pivot: readonly [number, number];
  sway?: number;
  front?: boolean;
  keep?: boolean;
};

export type Palette = { body: string; inner: string; tip?: string; accent?: string; eye: string };

/**
 * Where the accessories meet the head, measured off its outline: the top and
 * the chin on the middle line, the left edge at the glasses' height (temple),
 * the ear cups' (side) and over the chin (neck), and the smallest circle
 * around the whole creature with its ears folded, centered on the middle line.
 */
export type Fit = {
  top: number;
  chin: number;
  temple: number;
  side: number;
  neck: number;
  helmet: readonly [cy: number, r: number];
  /** Where the headphones' band crosses the middle line, when not just over the top. */
  band?: number;
  /** Moves the bow and the flower from where they sit on the round head. */
  hair?: readonly [dx: number, dy: number];
};

/** The round BODY. */
export const ROUND_FIT: Fit = { top: 28, chin: 88, temple: 20.5, side: 20, neck: 29.5, helmet: [53, 35] };

export type KindArt = Palette & {
  name: string;
  bowtie: string;
  knot: string;
  rim: boolean;
  /** The head's outline; a circle (BODY) when absent. Every shape holds the eyes' range. */
  shape?: string;
  ear?: EarArt;
  top?: TopArt;
  /** Behind the head. */
  back?: readonly Part[];
  /** On the head, clipped to it, under the eyes. */
  marks?: readonly Part[];
  /** Over the eyes. */
  front?: readonly Part[];
  /** Where the eyes show (a mask, a screen); the head when absent. */
  eyeClip?: string;
  /** The left eye's own patch (x0, y0, x1, y1), mirrored for the right: the eye sits in its middle and never leaves it. */
  socket?: { box: readonly [number, number, number, number]; scale?: number };
  /** Round eyes this wide instead of the tall ones, with a pupil (`pupil` of the eye; `shut` fills the closed eye with it) and a glint on it. */
  iris?: { size: number; fill: Paint; pupil: number; shut?: boolean; glint?: Paint };
  /** Moves the hats up or down to sit on the head's top. */
  hat?: number;
  /** Shrinks the hats around their brim, for a head whose top is already a cap. */
  hatScale?: number;
  /** ROUND_FIT, with what differs. */
  fit?: Partial<Fit>;
  colors?: Record<string, Partial<Palette & { rim: boolean }>>;
};

export const BODY = { cx: 50, cy: 58, r: 30 } as const;

export const BOWTIE = {
  left: "M50 90 L37 83 Q35.4 90 37 97 Z",
  right: "M50 90 L63 83 Q64.6 90 63 97 Z",
  knot: { x: 46.5, y: 86.5, width: 7, height: 7, rx: 1.5 },
  center: [50, 90] as const,
} as const;

export const BRAND_GREEN = "#4add8c";
export const EYE_WHITE = "#f8f8fa";
export const EYE_DARK = "#1d1b24";
export const GREEN_TIE = { bowtie: BRAND_GREEN, knot: "#3cc47a" } as const;
export const RED_TIE = { bowtie: "#f0475b", knot: "#d43246" } as const;
export const BLUE_TIE = { bowtie: "#4f8cff", knot: "#3a72e0" } as const;

const n = (v: number) => +v.toFixed(2);

/** `deg` turns it clockwise. */
export function ellipse(cx: number, cy: number, rx: number, ry = rx, deg = 0) {
  const a = (deg * Math.PI) / 180;
  const dx = rx * Math.cos(a);
  const dy = rx * Math.sin(a);
  const arc = `A${rx} ${ry} ${deg} 1 0`;
  return `M${n(cx - dx)} ${n(cy - dy)} ${arc} ${n(cx + dx)} ${n(cy + dy)} ${arc} ${n(cx - dx)} ${n(cy - dy)} Z`;
}

export const circle = (cx: number, cy: number, r: number) => ellipse(cx, cy, r);

/** A stroke from (x1, y1) to (x2, y2) with round ends, as a filled outline. */
export function capsule(x1: number, y1: number, x2: number, y2: number, r: number) {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const px = (-(y2 - y1) / len) * r;
  const py = ((x2 - x1) / len) * r;
  return `M${n(x1 + px)} ${n(y1 + py)} L${n(x2 + px)} ${n(y2 + py)} A${r} ${r} 0 0 0 ${n(x2 - px)} ${n(y2 - py)} L${n(x1 - px)} ${n(y1 - py)} A${r} ${r} 0 0 0 ${n(x1 + px)} ${n(y1 + py)} Z`;
}

export const roundRect = (x: number, y: number, w: number, h: number, r: number) =>
  `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`;

const SLOTS = new Set(["body", "inner", "tip", "accent", "eye"]);

export function paint(art: KindArt, value: Paint | undefined): string | undefined {
  if (value === undefined) return undefined;
  return SLOTS.has(value) ? (art[value as keyof Palette] ?? art.body) : value;
}

export const fitOf = (art: KindArt): Fit => (art.fit ? { ...ROUND_FIT, ...art.fit } : ROUND_FIT);

export function withColor(art: KindArt, color?: string): KindArt {
  const variant = color ? art.colors?.[color] : undefined;
  return variant ? { ...art, ...variant } : art;
}
