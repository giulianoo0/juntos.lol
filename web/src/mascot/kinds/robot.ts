import { RED_TIE, capsule, circle, roundRect, type KindArt } from "../kind";

export const SCREEN_RECT = { x: 25, y: 38, width: 50, height: 33, rx: 8 } as const;
const SCREEN = roundRect(SCREEN_RECT.x, SCREEN_RECT.y, SCREEN_RECT.width, SCREEN_RECT.height, SCREEN_RECT.rx);

export const robot: KindArt = {
  name: "Robô",
  body: "#9aabc1",
  inner: "#1a2230",
  tip: "#6e8098",
  accent: "#ff5d5d",
  eye: "#72f1ff",
  ...RED_TIE,
  rim: false,
  shape: roundRect(18, 29, 64, 59, 11),
  ear: { path: roundRect(12, 49, 9, 18, 2.6), fill: "tip", pivot: [20, 58], sway: 0 },
  top: { path: capsule(50, 30, 50, 17, 1.6), fill: "tip", parts: [{ d: circle(50, 14.5, 4.2), fill: "accent" }], pivot: [50, 30] },
  marks: [
    { d: SCREEN, fill: "inner" },
    { d: `${circle(23.5, 34.5, 1.6)} ${circle(76.5, 34.5, 1.6)} ${circle(23.5, 82.5, 1.6)} ${circle(76.5, 82.5, 1.6)}`, fill: "tip" },
    { d: "M40 79.5 H60", stroke: "tip", width: 2.6 },
  ],
  eyeClip: SCREEN,
  socket: { box: [28.5, 40.5, 48.5, 68.5] },
  fit: { top: 29, temple: 18, side: 18, neck: 18.25, helmet: [58.25, 39.8] },
  colors: {
    dourado: { body: "#e2b85c", tip: "#b48a35" },
    rosa: { body: "#f4a7c4", tip: "#d0789c", accent: "#5b7cff" },
  },
};
