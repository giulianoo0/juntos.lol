import type { MascotExpression } from "./types";

export type EarPose = { angle: number; lift: number };

export const EAR_POSES = {
  up: { angle: -3, lift: -1.5 },
  relaxed: { angle: 7, lift: 0 },
  drooped: { angle: 28, lift: 4 },
  hidden: { angle: 0, lift: 26 },
} as const satisfies Record<string, EarPose>;

export type EarPoseName = keyof typeof EAR_POSES;

export function earPoseFor(expression: MascotExpression): EarPoseName {
  switch (expression) {
    case "listening":
    case "speaking":
      return "up";
    case "error":
      return "drooped";
    default:
      return "relaxed";
  }
}

/** `tuck` folds the ear toward its base (inside the space helmet). */
export function earTransform(pose: EarPose, pivot: readonly [number, number], tuck = 1): string {
  const base = `translate(0 ${pose.lift.toFixed(3)}) rotate(${(-pose.angle).toFixed(3)} ${pivot[0]} ${pivot[1]})`;
  if (tuck === 1) return base;
  return `${base} translate(${pivot[0]} ${pivot[1]}) scale(${tuck}) translate(${-pivot[0]} ${-pivot[1]})`;
}
