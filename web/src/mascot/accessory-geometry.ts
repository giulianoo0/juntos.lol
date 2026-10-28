import { DEFAULT_EYES, FRONT_GAZE, projectEye, type EyeLayout, type EyeRender } from "./eyes";
import { ROUND_FIT, fitOf, type KindArt } from "./kind";
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

const n = (v: number) => +v.toFixed(2);

export const HEADPHONES = {
  cup: { width: 11, height: 21, y: 50, inset: 1 },
  /** How round the band is: 0.55 follows a circle. */
  bulge: 0.56,
  /** Opacity of the light on each cup. */
  light: { live: 1, idle: 0.28 },
} as const;

export type Headphones = { cups: readonly [LensRect, LensRect]; band: string; foot: number; apex: number; x: number };

/** The cups sit on the sides of the head and the band hugs its top, from cup to cup. */
export function headphonesFor(art?: KindArt): Headphones {
  const fit = art ? fitOf(art) : ROUND_FIT;
  const { cup, bulge } = HEADPHONES;
  const x = fit.side + cup.inset;
  const foot = cup.y + 2;
  const apex = fit.band ?? fit.top - 1.5;
  const lift = n(foot - bulge * (foot - apex));
  const reach = n(50 - bulge * (50 - x));
  const rect = (cx: number): LensRect => ({ x: n(cx - cup.width / 2), y: cup.y, width: cup.width, height: cup.height, rx: 4 });
  return {
    cups: [rect(x), rect(100 - x)],
    band: `M${n(x)} ${foot} C${n(x)} ${lift} ${reach} ${n(apex)} 50 ${n(apex)} S${n(100 - x)} ${lift} ${n(100 - x)} ${foot}`,
    foot,
    apex,
    x,
  };
}

/** The headphones light up while the mascot listens or speaks. */
export const headphonesLive = (expression: MascotExpression): boolean => expression === "listening" || expression === "speaking";

/** The scarf's top edge dips to y≈84 in the middle and rises to 78 at the sides, on the round head. */
export const SCARF = { top: 78 } as const;

/** Wraps the head just over its chin, as wide as the head is there. */
export function scarfFor(art?: KindArt) {
  const fit = art ? fitOf(art) : ROUND_FIT;
  const dy = fit.chin - ROUND_FIT.chin;
  const sx = Math.min(1.3, Math.max(0.75, (54.5 - fit.neck) / (54.5 - ROUND_FIT.neck)));
  return { top: SCARF.top + dy, transform: `translate(50 ${n(dy)}) scale(${n(sx)} 1) translate(-50 0)` };
}

/** The bow tie's top on the round head; the knot overlaps the chin. */
export const BOWTIE_TOP = 80.5;

export function bowtieFor(art?: KindArt) {
  const dy = (art ? fitOf(art) : ROUND_FIT).chin - ROUND_FIT.chin;
  return { top: BOWTIE_TOP + dy, transform: `translate(0 ${n(dy + BOWTIE_TOP - 83)})` };
}

/**
 * The fishbowl: centered on the creature (its ears folded to `earTuck`), a
 * little bigger than it and inside the drawing; a creature too big for the
 * largest bowl shrinks into it.
 */
export const HELMET = { cx: 50, cy: 53, r: 46, max: 46.5, air: 4.5, stroke: 2.6, earTuck: 0.6, glint: { speaking: 0.6, idle: 0.42 } } as const;

export function helmetFor(art?: KindArt) {
  const [cy, r] = (art ? fitOf(art) : ROUND_FIT).helmet;
  const radius = Math.min(HELMET.max, r + HELMET.air);
  const scale = Math.min(1, (radius - HELMET.air) / r);
  const center = Math.min(Math.max(cy, 6 + radius), 100 - radius);
  return { cx: 50, cy: n(center), r: n(radius), transform: `translate(50 ${n(center)}) scale(${n(scale)}) translate(-50 ${n(-cy)})` };
}

/** Where the hats meet the head, the point they shrink toward. */
export const HAT_BRIM = 44;

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
function cupsFrame({ cups }: Headphones): EyeFrame {
  const x = { x0: cups[0].x + cups[0].width + 1.5, x1: cups[1].x - 1.5 };
  return { left: { ...x, y0: 20, y1: 90 }, right: { ...x, y0: 20, y1: 90 }, scale: 1, centered: false, clip: null };
}
const cups = cupsFrame(headphonesFor());

function aboveFrame(top: number): EyeFrame {
  const box = { x0: FACE.x0, y0: 20, x1: FACE.x1, y1: top - 1 };
  return { left: box, right: box, scale: 1, centered: false, clip: null };
}

export const EYE_FRAMES: Record<MascotAccessory, EyeFrame | null> = {
  none: null,
  bowtie: aboveFrame(BOWTIE_TOP),
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
  scarf: aboveFrame(SCARF.top),
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

const frames = new WeakMap<KindArt, Map<MascotAccessory, EyeFrame | null>>();

const meet = (a: Box, b?: Box): Box => (b ? { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) } : a);

/** The kind's sockets inside the accessory's frame; lenses keep their own. */
function socketFrame(art: KindArt, frame: EyeFrame | null): EyeFrame | null {
  if (!art.socket || frame?.clip) return frame;
  const [x0, y0, x1, y1] = art.socket.box;
  const left = meet({ x0, y0, x1, y1 }, frame?.left);
  const right = meet({ x0: 100 - x1, y0, x1: 100 - x0, y1 }, frame?.right);
  return { left, right, scale: art.socket.scale ?? 1, centered: true, clip: null };
}

/** A round eye takes the widest square of a round glass and most of its height. */
function roundInLens(frame: EyeFrame, size: number, accessory: MascotAccessory): EyeFrame {
  const half = (roundLeft.rx - MARGIN) / Math.SQRT2;
  const boxes = accessory === "round-glasses" ? { left: roundBox(roundLeft, half), right: roundBox(roundRight, half) } : frame;
  return { ...frame, left: boxes.left, right: boxes.right, scale: (0.85 * (boxes.left.y1 - boxes.left.y0)) / size };
}

/**
 * The frame on this head: the brim rides the hat (`KindArt.hat`), the cups sit
 * on the head's sides and the scarf and the bow tie over its chin; a kind with
 * sockets keeps each eye in its own, and round eyes fill most of a lens.
 */
export function eyeFrameFor(accessory: MascotAccessory, art?: KindArt): EyeFrame | null {
  const frame = EYE_FRAMES[accessory];
  if (!art || (!frame && !art.socket)) return frame;
  let known = frames.get(art);
  if (!known) frames.set(art, (known = new Map()));
  if (known.has(accessory)) return known.get(accessory)!;
  let fitted = frame;
  if (frame && HATS.has(accessory)) {
    const y0 = HAT_BRIM + (frame.left.y0 - HAT_BRIM) * (art.hatScale ?? 1) + (art.hat ?? 0);
    fitted = { ...frame, left: { ...frame.left, y0 }, right: { ...frame.right, y0 } };
  } else if (accessory === "headphones" || accessory === "cat-headphones") fitted = cupsFrame(headphonesFor(art));
  else if (accessory === "scarf") fitted = aboveFrame(scarfFor(art).top);
  else if (accessory === "bowtie") fitted = aboveFrame(bowtieFor(art).top);
  fitted = socketFrame(art, fitted);
  if (art.iris && fitted?.clip) fitted = roundInLens(fitted, art.iris.size, accessory);
  known.set(accessory, fitted);
  return fitted;
}

/** The kind's eyes before any pose: round ones keep their own size. */
export const eyeLayoutFor = (art?: KindArt): EyeLayout => (art?.iris ? { ...DEFAULT_EYES, width: art.iris.size, height: art.iris.size } : DEFAULT_EYES);

/** Ears and the top fold into the helmet; every other accessory leaves them as they are. */
export const earTuckFor = (accessory: MascotAccessory): number => (accessory === "space-helmet" ? HELMET.earTuck : 1);

export const showsEars = (art: KindArt, accessory: MascotAccessory): boolean => Boolean(art.ear && !(art.ear.antenna && HATS.has(accessory)));

export const showsTop = (art: KindArt, accessory: MascotAccessory): boolean => Boolean(art.top && (art.top.keep || !HATS.has(accessory)));
