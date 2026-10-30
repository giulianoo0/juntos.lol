import type { MascotExpression } from "./types";

export type Gaze = { yaw: number; pitch: number };

export type EyeLayout = {
  cx: number;
  cy: number;
  radius: number;
  spread: number;
  lift: number;
  width: number;
  height: number;
};

export type EyeShape = { w: number; h: number };

export type EyeRender = { x: number; y: number; width: number; height: number; rx: number; rotate: number; opacity: number };

export type Iris = { x: number; y: number; width: number; height: number; rx: number; glint: readonly [cx: number, cy: number, r: number]; open: number };

export const DEFAULT_EYES: EyeLayout = {
  cx: 50,
  cy: 58,
  radius: 30,
  spread: Math.asin(10 / 30),
  lift: Math.asin(4 / 30),
  width: 7.5,
  height: 17,
};

export const REFLECTION_GAZE: Gaze = { yaw: 0.78, pitch: 0.62 };
export const FRONT_GAZE: Gaze = { yaw: 0, pitch: 0 };

const deg = (rad: number) => (rad * 180) / Math.PI;

export function projectEye(layout: EyeLayout, side: -1 | 1, gaze: Gaze, shape: EyeShape, blink = 1): EyeRender {
  const yaw = gaze.yaw + side * layout.spread;
  const pitch = gaze.pitch + layout.lift;
  const facing = Math.cos(yaw);
  const x = layout.cx + layout.radius * Math.sin(yaw) * Math.cos(pitch);
  const y = layout.cy - layout.radius * Math.sin(pitch);
  const width = layout.width * shape.w * Math.max(0, facing);
  const height = layout.height * shape.h * Math.cos(pitch) * blink;
  const rotate = -deg(yaw) * Math.sin(gaze.pitch) * 1.2;
  const opacity = facing <= 0.08 ? 0 : Math.min(1, (facing - 0.08) / 0.12);
  return { x, y, width, height, rx: Math.max(0, Math.min(width, height) / 2), rotate, opacity };
}

const clamp = (v: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, v));

/**
 * The pupil inside a round eye, before the eye's rotation: it leans toward the
 * gaze and, as the eye flattens (a blink, happy), shrinks away or fills it (`shut`).
 */
export function irisOf(eye: EyeRender, gaze: Gaze, pupil: number, shut = false): Iris {
  const open = clamp((eye.height / Math.max(eye.width, 1e-6) - 0.18) / 0.3, 0, 1);
  const k = shut ? 1 - (1 - pupil) * open : pupil * open;
  const width = eye.width * k;
  const height = Math.min(eye.height, width);
  // A diagonal look moves the pupil along a circle, not into the eye's corner.
  const lean = [clamp(gaze.yaw / 0.7), clamp(gaze.pitch / 0.5)] as const;
  const reach = Math.max(1, Math.hypot(...lean));
  const x = eye.x + ((eye.width - width) / 2) * 0.8 * (lean[0] / reach);
  const y = eye.y - ((eye.height - height) / 2) * 0.8 * (lean[1] / reach);
  const r = Math.min(width, height);
  return { x, y, width, height, rx: r / 2, glint: [x + width * 0.22, y - height * 0.22, r * 0.2], open };
}

export type ExpressionEyes = { shape: EyeShape; gaze: Gaze | null; followsLevel: boolean; blinks: boolean; glances: boolean };

export const EXPRESSION_EYES: Record<MascotExpression, ExpressionEyes> = {
  idle: { shape: { w: 1, h: 1 }, gaze: null, followsLevel: false, blinks: true, glances: true },
  listening: { shape: { w: 1, h: 1 }, gaze: { yaw: 0, pitch: 0.04 }, followsLevel: true, blinks: true, glances: false },
  thinking: { shape: { w: 0.8, h: 0.35 }, gaze: { yaw: 0.28, pitch: 0.5 }, followsLevel: false, blinks: false, glances: false },
  speaking: { shape: { w: 1, h: 1 }, gaze: FRONT_GAZE, followsLevel: true, blinks: true, glances: false },
  happy: { shape: { w: 1.55, h: 0.24 }, gaze: FRONT_GAZE, followsLevel: false, blinks: false, glances: false },
  error: { shape: { w: 0.85, h: 0.8 }, gaze: { yaw: 0, pitch: -0.28 }, followsLevel: false, blinks: true, glances: false },
};

export const LEVEL_GAIN = 0.15;

export function levelScale(level: number): number {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  return 1 + LEVEL_GAIN * clamped;
}

export const BLINK_MS = 110;

export function blinkFactor(elapsedMs: number): number {
  if (elapsedMs < 0 || elapsedMs >= BLINK_MS) return 1;
  const half = BLINK_MS / 2;
  return elapsedMs < half ? 1 - 0.9 * (elapsedMs / half) : 0.1 + 0.9 * ((elapsedMs - half) / half);
}

export function nextBlinkDelay(random: () => number): number {
  return 3000 + random() * 2000;
}

export const DOUBLE_BLINK_CHANCE = 0.25;
export const DOUBLE_BLINK_GAP_MS = 190;

export function nextGlanceDelay(random: () => number): number {
  return 2400 + random() * 2600;
}

export type Glance = { gaze: Gaze; wonder: boolean };

export function nextGlance(random: () => number): Glance {
  const wonder = random() < 0.12;
  if (wonder) return { gaze: { yaw: (random() - 0.5) * 0.2, pitch: 0.32 }, wonder: true };
  return { gaze: { yaw: (random() - 0.5) * 0.9, pitch: -0.1 + random() * 0.32 }, wonder: false };
}

export const WONDER_SHAPE: EyeShape = { w: 1.25, h: 1.22 };
export const WONDER_MS = 700;

export function lookAtGaze(lookAt: { x: number; y: number }): Gaze {
  const x = Math.max(-1, Math.min(1, lookAt.x));
  const y = Math.max(-1, Math.min(1, lookAt.y));
  return { yaw: x * 0.75, pitch: -y * 0.5 };
}
