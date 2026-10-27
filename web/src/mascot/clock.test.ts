import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rafClock } from "./clock";

describe("rafClock", () => {
  let pending: Array<(time: number) => void>;

  beforeEach(() => {
    pending = [];
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => pending.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const flush = (time: number) => {
    const run = pending;
    pending = [];
    for (const callback of run) callback(time);
  };

  it("runs every mascot's frame on one animation frame", () => {
    const seen: number[] = [];
    rafClock.frame((t) => seen.push(t));
    rafClock.frame((t) => seen.push(t + 1));
    rafClock.frame((t) => seen.push(t + 2));

    expect(pending).toHaveLength(1);
    flush(100);
    expect(seen).toEqual([100, 101, 102]);
  });

  it("leaves out a frame cancelled before it runs and asks for nothing once empty", () => {
    const seen: string[] = [];
    const cancel = rafClock.frame(() => seen.push("a"));
    rafClock.frame(() => seen.push("b"));
    cancel();
    flush(16);
    expect(seen).toEqual(["b"]);

    rafClock.frame(() => seen.push("c"))();
    flush(32);
    expect(seen).toEqual(["b"]);
  });

  it("lets a frame ask for the next one", () => {
    const seen: number[] = [];
    rafClock.frame((t) => {
      seen.push(t);
      rafClock.frame((next) => seen.push(next));
    });
    flush(16);
    expect(seen).toEqual([16]);
    flush(32);
    expect(seen).toEqual([16, 32]);
  });
});
