import { describe, expect, it } from "vitest";
import { DEFAULT_EYES, EAR_POSES, REFLECTION_GAZE, blinkFactor, earPoseFor, earTransform, levelScale, projectEye } from ".";
import { nextBlinkDelay, nextGlanceDelay } from "./eyes";

const front = { yaw: 0, pitch: 0 };
const pill = { w: 1, h: 1 };

describe("eyes on a fake sphere", () => {
  it("places the two eyes symmetric and full size when facing front", () => {
    const left = projectEye(DEFAULT_EYES, -1, front, pill);
    const right = projectEye(DEFAULT_EYES, 1, front, pill);
    expect(left.x + right.x).toBeCloseTo(100, 6);
    expect(right.x - left.x).toBeCloseTo(20 * Math.cos(DEFAULT_EYES.lift), 6);
    expect(left.y).toBeCloseTo(54, 1);
    expect(left.width).toBeCloseTo(7.5 * Math.cos(DEFAULT_EYES.spread), 6);
    expect(left.rotate).toBeCloseTo(0, 6);
  });

  it("follows x = R·sin(yaw)·cos(pitch), y = −R·sin(pitch) and scales by (cos yaw, cos pitch)", () => {
    const gaze = { yaw: 0.5, pitch: 0.3 };
    const eye = projectEye(DEFAULT_EYES, 1, gaze, pill);
    const yaw = 0.5 + DEFAULT_EYES.spread;
    const pitch = 0.3 + DEFAULT_EYES.lift;
    expect(eye.x).toBeCloseTo(50 + 30 * Math.sin(yaw) * Math.cos(pitch), 6);
    expect(eye.y).toBeCloseTo(58 - 30 * Math.sin(pitch), 6);
    expect(eye.width).toBeCloseTo(7.5 * Math.cos(yaw), 6);
    expect(eye.height).toBeCloseTo(17 * Math.cos(pitch), 6);
  });

  it("narrows the eye near the rim and hides it once it turns past the edge", () => {
    const near = projectEye(DEFAULT_EYES, 1, { yaw: 1.1, pitch: 0 }, pill);
    const far = projectEye(DEFAULT_EYES, -1, { yaw: 1.1, pitch: 0 }, pill);
    expect(near.width).toBeLessThan(far.width);
    expect(projectEye(DEFAULT_EYES, 1, { yaw: 1.4, pitch: 0 }, pill).opacity).toBe(0);
  });

  it("tilts like the gloss of an 8-ball in the reflection pose", () => {
    const eye = projectEye(DEFAULT_EYES, 1, REFLECTION_GAZE, pill);
    expect(eye.x).toBeGreaterThan(62);
    expect(eye.y).toBeLessThan(42);
    expect(eye.rotate).toBeLessThan(-30);
  });

  it("blinks 1 → 0.1 → 1 in 110 ms", () => {
    expect(blinkFactor(0)).toBe(1);
    expect(blinkFactor(55)).toBeCloseTo(0.1, 6);
    expect(blinkFactor(109)).toBeGreaterThan(0.9);
    expect(blinkFactor(110)).toBe(1);
  });

  it("scales the eyes from ×1 to ×1.15 with the audio level", () => {
    expect(levelScale(0)).toBe(1);
    expect(levelScale(1)).toBeCloseTo(1.15, 6);
    expect(levelScale(4)).toBeCloseTo(1.15, 6);
    expect(levelScale(Number.NaN)).toBe(1);
  });

  it("waits 3–5 s between blinks and 1.2–2.5 s between glances", () => {
    expect(nextBlinkDelay(() => 0)).toBe(3000);
    expect(nextBlinkDelay(() => 0.9999)).toBeLessThan(5000);
    expect(nextGlanceDelay(() => 0)).toBe(1200);
    expect(nextGlanceDelay(() => 0.9999)).toBeLessThan(2500);
  });
});

describe("ears", () => {
  it("stand up while listening or speaking, relax when idle and droop on error", () => {
    expect(earPoseFor("listening")).toBe("up");
    expect(earPoseFor("speaking")).toBe("up");
    expect(earPoseFor("idle")).toBe("relaxed");
    expect(earPoseFor("thinking")).toBe("relaxed");
    expect(earPoseFor("error")).toBe("drooped");
    expect(EAR_POSES.drooped.angle).toBeGreaterThan(EAR_POSES.relaxed.angle);
    expect(EAR_POSES.relaxed.angle).toBeGreaterThan(EAR_POSES.up.angle);
    expect(earTransform(EAR_POSES.drooped, [34, 37])).toBe("translate(0 4.000) rotate(-28.000 34 37)");
  });
});
