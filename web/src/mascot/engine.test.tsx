import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EYES, Mascot, lookAtGaze, projectEye } from ".";
import { createManualClock, setMascotClock, type ManualClock } from "./testing";

let clock: ManualClock;

function mockReducedMotion(reduced: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduced && query.includes("reduce"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  clock = createManualClock(0);
  setMascotClock(clock);
  mockReducedMotion(false);
});

afterEach(() => {
  cleanup();
  setMascotClock(null);
});

/** [x, y, degrees, scale x, scale y] of the head, all at rest without a transform. */
function headPose(container: HTMLElement): number[] {
  const transform = container.querySelector('[data-part="head"]')!.getAttribute("transform");
  if (!transform) return [0, 0, 0, 1, 1];
  const m = /translate\((\S+) (\S+)\) rotate\((\S+) [^)]+\) translate\([^)]+\) scale\((\S+) (\S+)\)/.exec(transform)!;
  return m.slice(1).map(Number);
}

const eyeHeight = (container: HTMLElement) => Number(container.querySelector('[data-eye="left"]')!.getAttribute("height"));

function sampleHeights(container: HTMLElement, ms: number) {
  const heights: number[] = [];
  for (let t = 0; t < ms; t += 16) {
    act(() => clock.advance(16));
    heights.push(eyeHeight(container));
  }
  return heights;
}

describe("Mascot engine", () => {
  it("blinks on its own within five seconds when idle", () => {
    const { container } = render(<Mascot kind="wolf" expression="idle" />);
    const open = eyeHeight(container);
    const heights = sampleHeights(container, 5200);
    expect(Math.min(...heights)).toBeLessThan(open * 0.5);
  });

  it("stays still with reduced motion: no blink, no glance", () => {
    mockReducedMotion(true);
    const { container } = render(<Mascot kind="wolf" expression="idle" />);
    const before = container.querySelector('[data-eye="left"]')!.outerHTML;
    sampleHeights(container, 6000);
    expect(container.querySelector('[data-eye="left"]')!.outerHTML).toBe(before);
  });

  it("holds still while asked to and blinks at once when let go", () => {
    const { container, rerender } = render(<Mascot kind="wolf" expression="idle" still />);
    const before = container.querySelector('[data-eye="left"]')!.outerHTML;
    sampleHeights(container, 6000);
    expect(container.querySelector('[data-eye="left"]')!.outerHTML).toBe(before);
    const open = eyeHeight(container);
    rerender(<Mascot kind="wolf" expression="idle" />);
    expect(Math.min(...sampleHeights(container, 200))).toBeLessThan(open * 0.5);
  });

  it("does not blink when let go under reduced motion", () => {
    mockReducedMotion(true);
    const { container, rerender } = render(<Mascot kind="wolf" expression="idle" still />);
    const before = container.querySelector('[data-eye="left"]')!.outerHTML;
    rerender(<Mascot kind="wolf" expression="idle" />);
    sampleHeights(container, 1000);
    expect(container.querySelector('[data-eye="left"]')!.outerHTML).toBe(before);
  });

  it("grows the eyes with the input level while listening", () => {
    const { container, rerender } = render(<Mascot kind="wolf" expression="listening" level={() => 0} />);
    sampleHeights(container, 400);
    const quiet = Math.max(...sampleHeights(container, 200));
    rerender(<Mascot kind="wolf" expression="listening" level={() => 1} />);
    const loud = Math.max(...sampleHeights(container, 600));
    expect(loud / quiet).toBeGreaterThan(1.1);
    expect(loud / quiet).toBeLessThan(1.16);
  });

  it("moves the ears and turns the eyes into dashes when the expression changes", () => {
    const { container, rerender } = render(<Mascot kind="wolf" expression="idle" />);
    rerender(<Mascot kind="wolf" expression="error" />);
    sampleHeights(container, 800);
    expect(container.querySelector("[data-ear-transform]")!.getAttribute("transform")).toMatch(/rotate\(-2[78]\.\d+/);
    rerender(<Mascot kind="wolf" expression="happy" />);
    sampleHeights(container, 800);
    const eye = container.querySelector('[data-eye="left"]')!;
    expect(Number(eye.getAttribute("width"))).toBeGreaterThan(Number(eye.getAttribute("height")) * 2.5);
  });

  it("turns the head toward where it looks, the eyes taking only part of the look", () => {
    const { container } = render(<Mascot kind="fox" expression="idle" lookAt={{ x: 1, y: 0 }} still />);
    sampleHeights(container, 1200);
    const [x, , deg] = headPose(container);
    expect(x).toBeGreaterThan(2);
    expect(deg).toBeGreaterThan(3);
    const full = projectEye(DEFAULT_EYES, 1, lookAtGaze({ x: 1, y: 0 }), { w: 1, h: 1 });
    const eye = container.querySelector('[data-eye="right"]')!;
    expect(Number(eye.getAttribute("x")) + Number(eye.getAttribute("width")) / 2).toBeLessThan(full.x - 3);
  });

  it("glances with the head, which carries the accessory", () => {
    const { container } = render(<Mascot kind="cat" expression="idle" accessory="crown" />);
    const turns = new Set<string>();
    for (let t = 0; t < 12000; t += 160) {
      sampleHeights(container, 160);
      turns.add(headPose(container)[0].toFixed(1));
    }
    expect(turns.size).toBeGreaterThan(3);
    expect(container.querySelector('[data-part="head"] [data-accessory="crown"]')).not.toBeNull();
  });

  it("hops into a happy face and stretches with the voice", () => {
    const { container, rerender } = render(<Mascot kind="bear" expression="idle" still />);
    rerender(<Mascot kind="bear" expression="happy" still={false} />);
    const ys: number[] = [];
    for (let t = 0; t < 600; t += 16) {
      sampleHeights(container, 16);
      ys.push(headPose(container)[1]);
    }
    expect(Math.min(...ys)).toBeLessThan(-0.8);
    rerender(<Mascot kind="bear" expression="speaking" level={() => 1} />);
    sampleHeights(container, 800);
    expect(headPose(container)[4]).toBeGreaterThan(1.03);
  });

  it("keeps the head where it is with reduced motion or while held", () => {
    for (const reduced of [true, false]) {
      mockReducedMotion(reduced);
      const { container, unmount } = render(<Mascot kind="wolf" expression="idle" still={!reduced} />);
      const before = container.querySelector('[data-part="head"]')!.getAttribute("transform");
      sampleHeights(container, 6000);
      expect(container.querySelector('[data-part="head"]')!.getAttribute("transform")).toBe(before);
      unmount();
    }
  });

  it("never moves the body", () => {
    const { container, rerender } = render(<Mascot kind="fox" expression="speaking" level={() => 1} />);
    const body = container.querySelector('[data-part="body"]')!.outerHTML;
    sampleHeights(container, 1000);
    rerender(<Mascot kind="fox" expression="error" />);
    sampleHeights(container, 1000);
    expect(container.querySelector('[data-part="body"]')!.outerHTML).toBe(body);
  });
});
