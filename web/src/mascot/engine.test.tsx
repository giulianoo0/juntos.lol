import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mascot } from ".";
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

  it("never moves the body", () => {
    const { container, rerender } = render(<Mascot kind="fox" expression="speaking" level={() => 1} />);
    const body = container.querySelector('[data-part="body"]')!.outerHTML;
    sampleHeights(container, 1000);
    rerender(<Mascot kind="fox" expression="error" />);
    sampleHeights(container, 1000);
    expect(container.querySelector('[data-part="body"]')!.outerHTML).toBe(body);
  });
});
