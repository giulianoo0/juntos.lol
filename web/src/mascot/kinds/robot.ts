import { RED_TIE, capsule, circle, roundRect, type KindArt } from "../kind";

const SCREEN = roundRect(25, 38, 50, 33, 8);

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
  colors: {
    dourado: { body: "#e2b85c", tip: "#b48a35" },
    rosa: { body: "#f4a7c4", tip: "#d0789c", accent: "#5b7cff" },
  },
};
