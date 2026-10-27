import type { Gaze } from "./eyes";

/** How much of a look the eyes take; the head turns toward the rest. */
export const EYE_SHARE = 0.6;

/** Softer than the eyes': the eyes get there first and the head follows. */
export const HEAD_SPRING = { stiffness: 140, damping: 17, mass: 1 } as const;

/**
 * `turn` and `nod` follow the look (yaw, pitch), `lift` raises the head (a
 * hop), `stretch` makes it taller and thinner (speech) or squashes it (a blink).
 */
export type HeadPose = { turn: number; nod: number; lift: number; stretch: number };

export const REST_HEAD: HeadPose = { turn: 0, nod: 0, lift: 0, stretch: 0 };

export const HEAD = { shift: 4.5, tilt: 7, rise: 3, thin: 0.45 } as const;

/** Squash and stretch for a blink (1 open → 0.1 shut) and for the voice (0 → 1). */
export const BLINK_SQUASH = 0.03;
export const TALK_STRETCH = 0.04;

/** The little jump into a happy face, as the head's upward speed. */
export const HOP = 45;

export const eyeGaze = (gaze: Gaze): Gaze => ({ yaw: gaze.yaw * EYE_SHARE, pitch: gaze.pitch * EYE_SHARE });

const f = (v: number) => v.toFixed(3);

/** Leans toward where it looks, tilting and squashing around the chin. */
export function headTransform(pose: HeadPose, chin: number): string | undefined {
  const x = pose.turn * HEAD.shift;
  const y = -pose.nod * HEAD.rise - pose.lift;
  const deg = pose.turn * HEAD.tilt;
  const sy = 1 + pose.stretch;
  const sx = 1 - pose.stretch * HEAD.thin;
  if (Math.abs(x) < 5e-4 && Math.abs(y) < 5e-4 && Math.abs(deg) < 5e-4 && Math.abs(pose.stretch) < 5e-5) return undefined;
  return `translate(${f(x)} ${f(y)}) rotate(${f(deg)} 50 ${chin}) translate(50 ${chin}) scale(${f(sx)} ${f(sy)}) translate(-50 ${-chin})`;
}

/** A slow breath: the head rises a little and stretches, from the chin. */
export const BREATH = {
  keyframes: [{ transform: "translate(0px, 0px) scale(1, 1)" }, { transform: "translate(0px, -0.6px) scale(0.992, 1.016)" }],
  half: 1800,
} as const;
