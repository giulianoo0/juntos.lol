import { describe, expect, it } from "vitest";
import { EXPRESSION_EYES, KINDS, MASCOT_ACCESSORIES, MASCOT_KINDS, projectEye, type MascotExpression, type MascotKind } from ".";
import { EYE_FRAMES, eyeFrameFor, eyeLayoutFor, fitEye } from "./accessory-geometry";
import { WONDER_SHAPE, irisOf, type EyeRender, type Gaze } from "./eyes";
import { NOSE } from "./kinds/koala";
import { PATCH } from "./kinds/panda";
import { SCREEN_RECT } from "./kinds/robot";

type Point = readonly [number, number];
type Ellipse = { cx: number; cy: number; rx: number; ry: number; deg?: number };

const EXPRESSIONS = Object.keys(EXPRESSION_EYES) as MascotExpression[];
const SHAPES = [...EXPRESSIONS.map((e) => EXPRESSION_EYES[e].shape), WONDER_SHAPE];

/** Every pose the eyes can take: gazes past the lookAt range, every shape, the voice level and the blink. */
function poses(): { gaze: Gaze; shape: { w: number; h: number }; blink: number }[] {
  const all = [];
  for (let yaw = -1.2; yaw <= 1.2 + 1e-6; yaw += 0.15)
    for (let pitch = -0.6; pitch <= 0.75 + 1e-6; pitch += 0.15)
      for (const shape of SHAPES)
        for (const level of [1, 1.15])
          for (const blink of [1, 0.5, 0.1]) all.push({ gaze: { yaw, pitch }, shape: { w: shape.w, h: shape.h * level }, blink });
  return all;
}
const POSES = poses();

/** The eye's outline: a rounded rect turned around its center, as the svg draws it. */
function outline(eye: { x: number; y: number; width: number; height: number; rx: number; rotate: number }, steps = 8): Point[] {
  const r = Math.min(eye.rx, eye.width / 2, eye.height / 2);
  const hx = eye.width / 2 - r;
  const hy = eye.height / 2 - r;
  const a = (eye.rotate * Math.PI) / 180;
  const points: Point[] = [];
  for (const [sx, sy, start] of [[1, 1, 0], [-1, 1, 90], [-1, -1, 180], [1, -1, 270]] as const)
    for (let i = 0; i <= steps; i++) {
      const t = ((start + (90 * i) / steps) * Math.PI) / 180;
      const x = sx * hx + r * Math.cos(t);
      const y = sy * hy + r * Math.sin(t);
      points.push([eye.x + x * Math.cos(a) - y * Math.sin(a), eye.y + x * Math.sin(a) + y * Math.cos(a)]);
    }
  return points;
}

/** < 1 inside the ellipse, 1 on it. */
function ellipseRadius([x, y]: Point, e: Ellipse): number {
  const a = ((e.deg ?? 0) * Math.PI) / 180;
  const dx = x - e.cx;
  const dy = y - e.cy;
  const u = dx * Math.cos(a) + dy * Math.sin(a);
  const v = -dx * Math.sin(a) + dy * Math.cos(a);
  return Math.hypot(u / e.rx, v / e.ry);
}

/** Inside an unturned rounded rect centered on (x, y). */
function inRoundRect([px, py]: Point, r: { x: number; y: number; width: number; height: number; rx: number }, tolerance = 1e-6): boolean {
  const rx = Math.min(r.rx, r.width / 2, r.height / 2);
  const dx = Math.max(0, Math.abs(px - r.x) - (r.width / 2 - rx));
  const dy = Math.max(0, Math.abs(py - r.y) - (r.height / 2 - rx));
  return Math.abs(px - r.x) <= r.width / 2 + tolerance && Math.abs(py - r.y) <= r.height / 2 + tolerance && Math.hypot(dx, dy) <= rx + tolerance;
}

const grow =(e: Ellipse, by: number): Ellipse => ({ ...e, rx: e.rx + by, ry: e.ry + by });
const mirror = ([x, y]: Point): Point => [100 - x, y];
/** A rule for the left half, mirrored for the right. */
const both = (rule: (p: Point) => boolean) => (p: Point) => rule(p[0] <= 50 ? p : mirror(p));

function bezier(points: readonly Point[], steps = 60): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    let level = points.slice();
    while (level.length > 1) level = level.slice(1).map((p, k) => [level[k]![0] + (p[0] - level[k]![0]) * t, level[k]![1] + (p[1] - level[k]![1]) * t] as Point);
    out.push(level[0]!);
  }
  return out;
}
const far = (curve: readonly Point[], gap: number) => (p: Point) => curve.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= gap);

/** The planet's ring, the half in front of the face (ellipse 38×9 at (50, 66), −12°). */
const RING_FRONT: Point[] = Array.from({ length: 73 }, (_, i) => {
  const t = (i / 72) * Math.PI;
  const a = (-12 * Math.PI) / 180;
  const x = 38 * Math.cos(t);
  const y = 9 * Math.sin(t);
  return [50 + x * Math.cos(a) - y * Math.sin(a), 66 + x * Math.sin(a) + y * Math.cos(a)] as Point;
});

const MARGIN = 0.6;

/**
 * What each eye must keep clear of, or stay inside, on the kinds whose face has
 * something next to the eyes: patches, a nose, stripes, a bucket, a ring.
 */
const KEEP: Partial<Record<MascotKind, { what: string; ok: (p: Point) => boolean }>> = {
  panda: { what: "inside its patch", ok: both((p) => ellipseRadius(p, grow(PATCH, -MARGIN)) <= 1) },
  owl: { what: "inside its disc", ok: both((p) => Math.hypot(p[0] - 38.5, p[1] - 54) <= 13 - MARGIN) },
  koala: { what: "off the nose", ok: (p) => ellipseRadius(p, grow(NOSE, 1.2)) >= 1 },
  robot: {
    what: "inside the screen",
    ok: (p) => {
      const { x, y, width, height, rx } = SCREEN_RECT;
      const inset = 1;
      const cx = Math.min(Math.max(p[0], x + rx), x + width - rx);
      const cy = Math.min(Math.max(p[1], y + rx), y + height - rx);
      return p[0] >= x + inset && p[0] <= x + width - inset && p[1] >= y + inset && p[1] <= y + height - inset && Math.hypot(p[0] - cx, p[1] - cy) <= rx - inset;
    },
  },
  bee: { what: "above the stripe", ok: (p) => p[1] <= 70 + 14 * ((p[0] - 18) / 64) * (1 - (p[0] - 18) / 64) - 2 },
  popcorn: { what: "above the bucket", ok: (p) => p[1] <= 63.4 - 1.2 },
  onigiri: { what: "above the nori", ok: (p) => p[1] <= 69 - 1.2 },
  planet: { what: "off the ring", ok: far(RING_FRONT, 2.2 + 1) },
  drop: { what: "off the shine", ok: far(bezier([[70, 64], [70, 74], [62, 80]]), 1.7 + 1) },
  mushroom: { what: "under the cap", ok: (p) => p[1] >= 43.2 + 1 },
  flame: { what: "under the notch", ok: both((p) => p[0] >= 38.5 || p[1] >= 46) },
  slime: { what: "inside the head", ok: both((p) => p[0] >= 39 || p[1] >= 47 - ((p[0] - 26) * 10.9) / 13.1 + 1) },
};

const NO_LENS = MASCOT_ACCESSORIES.map((a) => a.id).filter((id) => !EYE_FRAMES[id]?.clip);
const ALL = MASCOT_ACCESSORIES.map((a) => a.id);

function eyesOf(kind: MascotKind, accessory: (typeof ALL)[number], pose: (typeof POSES)[number]) {
  const art = KINDS[kind];
  const frame = eyeFrameFor(accessory, art);
  const layout = eyeLayoutFor(art);
  return ([-1, 1] as const).map((side) => fitEye(projectEye(layout, side, pose.gaze, pose.shape, pose.blink), side, frame)).filter((eye) => eye.opacity > 0) as EyeRender[];
}

describe("eye geometry, every pose", () => {
  for (const [kind, rule] of Object.entries(KEEP) as [MascotKind, NonNullable<(typeof KEEP)[MascotKind]>][]) {
    it(`keeps the ${kind}'s eyes ${rule.what}`, () => {
      const bad: string[] = [];
      for (const accessory of NO_LENS)
        for (const pose of POSES)
          for (const eye of eyesOf(kind, accessory, pose)) if (!outline(eye).every(rule.ok)) bad.push(`${accessory} ${JSON.stringify(pose)} ${JSON.stringify(eye)}`);
      expect(bad.slice(0, 3)).toEqual([]);
    });
  }

  it("keeps every pupil inside its eye, whichever way it looks and whatever the mascot wears", () => {
    for (const kind of MASCOT_KINDS.filter((k) => KINDS[k].iris)) {
      const iris = KINDS[kind].iris!;
      const bad: string[] = [];
      for (const accessory of ALL)
        for (const pose of POSES)
          for (const eye of eyesOf(kind, accessory, pose)) {
            const pupil = irisOf(eye, pose.gaze, iris.pupil, iris.shut);
            const box = { x0: eye.x - eye.width / 2, y0: eye.y - eye.height / 2, x1: eye.x + eye.width / 2, y1: eye.y + eye.height / 2 };
            const p = { x0: pupil.x - pupil.width / 2, y0: pupil.y - pupil.height / 2, x1: pupil.x + pupil.width / 2, y1: pupil.y + pupil.height / 2 };
            const inBox = p.x0 >= box.x0 - 1e-6 && p.x1 <= box.x1 + 1e-6 && p.y0 >= box.y0 - 1e-6 && p.y1 <= box.y1 + 1e-6;
            // Not just the boxes: the round pupil stays inside the eye's rounded outline.
            const inOutline = outline({ ...pupil, rotate: 0 }, 4).every((q) => inRoundRect(q, eye));
            if (!inBox || !inOutline) bad.push(`${accessory} ${JSON.stringify(pose)}`);
          }
      expect(bad.slice(0, 3), kind).toEqual([]);
    }
  });

  it("draws the two eyes as mirror images when the look is straight ahead", () => {
    for (const kind of MASCOT_KINDS)
      for (const accessory of ALL)
        for (const pose of POSES.filter((p) => Math.abs(p.gaze.yaw) < 1e-9)) {
          const [left, right] = eyesOf(kind, accessory, pose);
          const at = `${kind} ${accessory} ${JSON.stringify(pose)}`;
          expect(left!.x + right!.x, at).toBeCloseTo(100, 6);
          expect(left!.y, at).toBeCloseTo(right!.y, 6);
          expect(left!.width, at).toBeCloseTo(right!.width, 6);
          expect(left!.height, at).toBeCloseTo(right!.height, 6);
          expect(left!.rotate, at).toBeCloseTo(-right!.rotate, 6);
        }
  });

  it("closes every eye to a thin line at the bottom of a blink and opens it back to the same size", () => {
    for (const kind of MASCOT_KINDS) {
      const pose = { gaze: { yaw: 0, pitch: 0 }, shape: { w: 1, h: 1 } };
      const [open] = eyesOf(kind, "none", { ...pose, blink: 1 });
      const [shut] = eyesOf(kind, "none", { ...pose, blink: 0.1 });
      expect(shut!.height, kind).toBeLessThan(open!.height * 0.15);
      expect(shut!.width, kind).toBeCloseTo(open!.width, 6);
      expect(shut!.x, kind).toBeCloseTo(open!.x, 6);
    }
  });
});
