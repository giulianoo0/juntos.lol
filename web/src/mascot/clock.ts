export type Clock = {
  now(): number;
  /** Runs `callback` on the next animation frame. */
  frame(callback: (time: number) => void): () => void;
  /** Runs `callback` once after `ms` milliseconds. */
  after(ms: number, callback: () => void): () => void;
};

export const rafClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  frame: (callback) => {
    if (typeof requestAnimationFrame !== "function") return () => {};
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  },
  after: (ms, callback) => {
    const id = setTimeout(callback, ms);
    return () => clearTimeout(id);
  },
};

let current: Clock = rafClock;

export function getMascotClock(): Clock {
  return current;
}

export function setMascotClock(clock: Clock | null): void {
  current = clock ?? rafClock;
}
