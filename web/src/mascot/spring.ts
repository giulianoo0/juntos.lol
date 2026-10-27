export type Spring = { value: number; velocity: number; target: number };

export const SPRING = { stiffness: 300, damping: 30, mass: 1 } as const;

export function spring(value: number): Spring {
  return { value, velocity: 0, target: value };
}

export function stepSpring(s: Spring, dtMs: number, config: { stiffness: number; damping: number; mass: number } = SPRING): void {
  let remaining = Math.min(dtMs, 64) / 1000;
  while (remaining > 0) {
    const h = Math.min(remaining, 1 / 240);
    const force = -config.stiffness * (s.value - s.target) - config.damping * s.velocity;
    s.velocity += (force / config.mass) * h;
    s.value += s.velocity * h;
    remaining -= h;
  }
}

export function settled(s: Spring, epsilon = 0.001): boolean {
  return Math.abs(s.value - s.target) < epsilon && Math.abs(s.velocity) < epsilon * 10;
}

export function snap(s: Spring, target = s.target): void {
  s.target = target;
  s.value = target;
  s.velocity = 0;
}
