export type Clock = {
  now(): number;
  /** Runs `callback` on the next animation frame. */
  frame(callback: (time: number) => void): () => void;
  /** Runs `callback` once after `ms` milliseconds. */
  after(ms: number, callback: () => void): () => void;
};

// Every mascot on the page steps on one animation frame: a room full of faces
// asks the browser for one callback, not one each.
const waiting = new Set<(time: number) => void>();
let requested = false;

function runFrame(time: number) {
  requested = false;
  const run = [...waiting];
  waiting.clear();
  for (const callback of run) callback(time);
}

export const rafClock: Clock = {
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
  frame: (callback) => {
    if (typeof requestAnimationFrame !== "function") return () => {};
    // A wrapper per call, so the same callback asked twice runs twice.
    const entry = (time: number) => callback(time);
    waiting.add(entry);
    if (!requested) {
      requested = true;
      requestAnimationFrame(runFrame);
    }
    return () => waiting.delete(entry);
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
