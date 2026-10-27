import type { Clock } from "./clock";

export { getMascotClock, rafClock, setMascotClock, type Clock } from "./clock";

export type ManualClock = Clock & {
  /** Moves time forward in 16 ms steps, firing due timers, then frames. */
  advance(ms: number): void;
};

/** Virtual time for tests: nothing runs until `advance` is called. */
export function createManualClock(start = 0): ManualClock {
  let time = start;
  let frames: Array<{ id: number; callback: (t: number) => void }> = [];
  let timers: Array<{ id: number; due: number; callback: () => void }> = [];
  let nextId = 0;
  return {
    now: () => time,
    frame(callback) {
      const id = ++nextId;
      frames.push({ id, callback });
      return () => {
        frames = frames.filter((entry) => entry.id !== id);
      };
    },
    after(ms, callback) {
      const id = ++nextId;
      timers.push({ id, due: time + ms, callback });
      return () => {
        timers = timers.filter((entry) => entry.id !== id);
      };
    },
    advance(ms) {
      const steps = Math.max(1, Math.ceil(ms / 16));
      const step = ms / steps;
      for (let i = 0; i < steps; i++) {
        time += step;
        const due = timers.filter((entry) => entry.due <= time).sort((a, b) => a.due - b.due);
        timers = timers.filter((entry) => entry.due > time);
        for (const entry of due) entry.callback();
        const run = frames;
        frames = [];
        for (const entry of run) entry.callback(time);
      }
    },
  };
}
