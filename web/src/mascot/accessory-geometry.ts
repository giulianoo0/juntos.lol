import { DEFAULT_EYES, FRONT_GAZE, projectEye, type EyeRender } from "./eyes";
import type { KindArt } from "./kind";
import type { MascotAccessory, MascotExpression } from "./types";

/**
 * Where the accessories sit on the 100×100 head, shared by the drawing
 * (accessories.tsx) and by the eyes, which have to stay inside the lenses and
 * clear of the brim, the ear cups and the scarf whatever they are doing.
 */

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type LensRect = { x: number; y: number; width: number; height: number; rx: number };

export const SUNGLASSES = {
  left: { x: 29.5, y: 45, width: 19, height: 15, rx: 4.5 },
  right: { x: 51.5, y: 45, width: 19, height: 15, rx: 4.5 },
  stroke: 2.4,
  /** Tinted glass: the eyes show through, dimmed. */
  tint: 0.62,
} as const;

const lens = (cx: number, cy: number, r: number): LensRect => ({ x: cx - r, y: cy - r, width: r * 2, height: r * 2, rx: r });

export const ROUND_GLASSES = { left: lens(39.5, 54, 9.5), right: lens(60.5, 54, 9.5), stroke: 2 } as const;

/** The glass inside a lens frame (the stroke is centered on the lens outline). */
export function lensGlass(lens: LensRect, stroke: number = SUNGLASSES.stroke): LensRect {
  const inset = stroke / 2;
  return { x: lens.x + inset, y: lens.y + inset, width: lens.width - stroke, height: lens.height - stroke, rx: Math.max(0, lens.rx - inset) };
}

/** Moved up from the eyes: the brim ends above them, with a little air. */
export const BEANIE = { lift: -6.5, brim: { x: 19.5, y: 34, width: 61, height: 9 } } as const;

export const CAP = { bill: 45.5 } as const;

export const CROWN = { base: 36 } as const;

export const HEADPHONES = {
  cups: [
    { x: 12.5, y: 50, width: 11, height: 21 },
    { x: 76.5, y: 50, width: 11, height: 21 },
  ],
  /** The band's lower edge reaches y≈44 where it meets the cups. */
  bandBottom: 44,
  /** Opacity of the light on each cup. */
  light: { live: 1, idle: 0.28 },
} as const;

/** The headphones light up while the mascot listens or speaks. */
export const headphonesLive = (expression: MascotExpression): boolean => expression === "listening" || expression === "speaking";

/** The scarf's top edge dips to y≈84 in the middle and rises to 78 at the sides. */
export const SCARF = { top: 78 } as const;

export const BOWTIE_TOP = 83;

/**
 * The fishbowl: centered on the face, big enough for the head and the ears,
 * which fold to `earTuck` of their length inside the glass.
 */
export const HELMET = { cx: 50, cy: 53, r: 46, stroke: 2.6, earTuck: 0.6, glint: { speaking: 0.6, idle: 0.42 } } as const;

/** Sit on the head's top, follow `KindArt.hat` and hide the top unless it is kept. */
export const HATS: ReadonlySet<MascotAccessory> = new Set(["beanie", "cap", "crown"]);
/** Follow `KindArt.hat` without hiding anything. */
export const HAIR: ReadonlySet<MascotAccessory> = new Set(["bow", "flower"]);

/**
 * Where each eye may go while wearing the accessory: the eye's whole box stays
 * inside. Lenses also shrink the eyes (`scale`), center them in the glass and
 * clip them to it.
 */
export type EyeFrame = { left: Box; right: Box; scale: number; centered: boolean; clip: readonly LensRect[] | null };

const MARGIN = 0.8;

function inset(rect: LensRect, by: number): Box {
  return { x0: rect.x + by, y0: rect.y + by, x1: rect.x + rect.width - by, y1: rect.y + rect.height - by };
}

/** The tallest box this wide that fits a round glass. */
function roundBox(glass: LensRect, halfWidth: number): Box {
  const r = glass.rx - MARGIN;
  const cx = glass.x + glass.rx;
  const cy = glass.y + glass.rx;
  const halfHeight = Math.sqrt(r * r - halfWidth * halfWidth);
  return { x0: cx - halfWidth, y0: cy - halfHeight, x1: cx + halfWidth, y1: cy + halfHeight };
}

const glassLeft = lensGlass(SUNGLASSES.left);
const glassRight = lensGlass(SUNGLASSES.right);
const roundLeft = lensGlass(ROUND_GLASSES.left, ROUND_GLASSES.stroke);
const roundRight = lensGlass(ROUND_GLASSES.right, ROUND_GLASSES.stroke);
/** The eye at rest, before any accessory. */
export const REST_EYE = { left: projectEye(DEFAULT_EYES, -1, FRONT_GAZE, { w: 1, h: 1 }), right: projectEye(DEFAULT_EYES, 1, FRONT_GAZE, { w: 1, h: 1 }) };
const lensBox = inset(glassLeft, MARGIN);
/** The open eye fits the lens height with a margin, listening level included. */
const LENS_SCALE = (lensBox.y1 - lensBox.y0) / (REST_EYE.left.height * 1.17);
const ROUND_HALF_WIDTH = 3.6;
const roundLensBox = roundBox(roundLeft, ROUND_HALF_WIDTH);
const ROUND_SCALE = (roundLensBox.y1 - roundLensBox.y0) / (REST_EYE.left.height * 1.17);

const FACE = { x0: 18, x1: 82 } as const;

const below = (y0: number): EyeFrame => ({ left: { x0: FACE.x0, y0, x1: FACE.x1, y1: 90 }, right: { x0: FACE.x0, y0, x1: FACE.x1, y1: 90 }, scale: 1, centered: false, clip: null });
const cupsX = { x0: HEADPHONES.cups[0].x + HEADPHONES.cups[0].width + 1.5, x1: HEADPHONES.cups[1].x - 1.5 };
const cups: EyeFrame = {
  left: { ...cupsX, y0: HEADPHONES.bandBottom, y1: 90 },
  right: { ...cupsX, y0: HEADPHONES.bandBottom, y1: 90 },
  scale: 1,
  centered: false,
  clip: null,
};

export const EYE_FRAMES: Record<MascotAccessory, EyeFrame | null> = {
  none: null,
  bowtie: null,
  bow: null,
  flower: null,
  sunglasses: { left: inset(glassLeft, MARGIN), right: inset(glassRight, MARGIN), scale: LENS_SCALE, centered: true, clip: [glassLeft, glassRight] },
  "round-glasses": {
    left: roundBox(roundLeft, ROUND_HALF_WIDTH),
    right: roundBox(roundRight, ROUND_HALF_WIDTH),
    scale: ROUND_SCALE,
    centered: true,
    clip: [roundLeft, roundRight],
  },
  beanie: below(BEANIE.brim.y + BEANIE.brim.height + 1.2),
  cap: below(CAP.bill + 0.8),
  crown: below(CROWN.base + 0.6),
  headphones: cups,
  "cat-headphones": cups,
  scarf: {
    left: { x0: FACE.x0, y0: 20, x1: FACE.x1, y1: SCARF.top - 1 },
    right: { x0: FACE.x0, y0: 20, x1: FACE.x1, y1: SCARF.top - 1 },
    scale: 1,
    centered: false,
    clip: null,
  },
  "space-helmet": null,
};

/** Linear up to 70 % of the limit, then eases into it: the eyes slow down before the edge instead of hitting it. */
export function softLimit(d: number, limit: number): number {
  if (limit <= 0) return 0;
  const a = Math.abs(d);
  const knee = limit * 0.7;
  if (a <= knee) return d;
  return Math.sign(d) * (knee + (limit - knee) * Math.tanh((a - knee) / (limit - knee)));
}

/** Half the size of the eye's box once rotated. */
function halfExtent(width: number, height: number, rotateDeg: number) {
  const r = (rotateDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return { x: (width * c + height * s) / 2, y: (width * s + height * c) / 2 };
}

/** The eye's own box, rotation included. */
export function eyeBox(eye: EyeRender): Box {
  const half = halfExtent(eye.width, eye.height, eye.rotate);
  return { x0: eye.x - half.x, y0: eye.y - half.y, x1: eye.x + half.x, y1: eye.y + half.y };
}

/**
 * Keeps a projected eye inside the accessory's frame: lenses shrink it and
 * carry its motion around the lens center; every frame eases the travel into
 * its edges and, if the eye is still too big (a wide-eyed glance), shrinks it.
 */
export function fitEye(eye: EyeRender, side: -1 | 1, frame: EyeFrame | null): EyeRender {
  if (!frame) return eye;
  const box = side < 0 ? frame.left : frame.right;
  const rest = side < 0 ? REST_EYE.left : REST_EYE.right;
  const rotate = frame.centered ? eye.rotate * 0.35 : eye.rotate;
  let width = eye.width * frame.scale;
  let height = eye.height * frame.scale;
  let half = halfExtent(width, height, rotate);
  const room = { x: (box.x1 - box.x0) / 2, y: (box.y1 - box.y0) / 2 };
  const shrink = Math.min(1, room.x / Math.max(half.x, 1e-6), room.y / Math.max(half.y, 1e-6));
  if (shrink < 1) {
    width *= shrink;
    height *= shrink;
    half = halfExtent(width, height, rotate);
  }
  const anchor = frame.centered ? { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 } : { x: rest.x, y: rest.y };
  const along = (d: number, low: number, high: number) => (d >= 0 ? softLimit(d, high) : -softLimit(-d, low));
  const dx = (eye.x - rest.x) * frame.scale;
  const dy = (eye.y - rest.y) * frame.scale;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const x = clamp(anchor.x + along(dx, anchor.x - half.x - box.x0, box.x1 - half.x - anchor.x), box.x0 + half.x, box.x1 - half.x);
  const y = clamp(anchor.y + along(dy, anchor.y - half.y - box.y0, box.y1 - half.y - anchor.y), box.y0 + half.y, box.y1 - half.y);
  return { ...eye, x, y, width, height, rx: Math.max(0, Math.min(width, height) / 2), rotate };
}

/** Hats ride the head's top (`KindArt.hat`), and the brim the eyes stay under rides with them. */
export function eyeFrameFor(accessory: MascotAccessory, art?: KindArt): EyeFrame | null {
  const frame = EYE_FRAMES[accessory];
  const lift = art?.hat ?? 0;
  if (!frame || !lift || !HATS.has(accessory)) return frame;
  return { ...frame, left: { ...frame.left, y0: frame.left.y0 + lift }, right: { ...frame.right, y0: frame.right.y0 + lift } };
}

/** Ears and the top fold into the helmet; every other accessory leaves them as they are. */
export const earTuckFor = (accessory: MascotAccessory): number => (accessory === "space-helmet" ? HELMET.earTuck : 1);

export const showsEars = (art: KindArt, accessory: MascotAccessory): boolean => Boolean(art.ear && !(art.ear.antenna && HATS.has(accessory)));

export const showsTop = (art: KindArt, accessory: MascotAccessory): boolean => Boolean(art.top && (art.top.keep || !HATS.has(accessory)));
