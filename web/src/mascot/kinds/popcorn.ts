import { GREEN_TIE, circle, type KindArt } from "../kind";

export const popcorn: KindArt = {
  name: "Pipoca",
  body: "#fff0c4",
  inner: "#f6c955",
  tip: "#e23b3b",
  eye: "#3a2a12",
  ...GREEN_TIE,
  rim: true,
  shape: "M22 74 A10 10 0 0 1 17 55 A11 11 0 0 1 27 37 A12 12 0 0 1 49 26 A12 12 0 0 1 71 32 A11 11 0 0 1 83 51 A10.5 10.5 0 0 1 79 74 Z",
  marks: [
    { d: circle(24, 47, 3), fill: "inner", opacity: 0.7 },
    { d: circle(60, 31, 2.6), fill: "inner", opacity: 0.7 },
    { d: circle(77, 59, 2.4), fill: "inner", opacity: 0.7 },
  ],
  front: [
    { d: "M19 66 H81 L74.5 92 H25.5 Z", fill: "#fff7ee" },
    { d: "M19 66 H31 L35.4 92 H25.5 Z M44 66 H56 L54.9 92 H45.1 Z M69 66 H81 L74.5 92 H64.6 Z", fill: "tip" },
    { d: "M17.5 63.4 H82.5 Q84 63.4 83.6 65 L83 68.4 H17 L16.4 65 Q16 63.4 17.5 63.4 Z", fill: "#c92d2d" },
  ],
  hat: -6,
  socket: { box: [30, 33, 49, 61.5] },
  fit: { top: 24.5, chin: 91.75, temple: 15.25, side: 16, neck: 23.5, helmet: [58, 43.1] },
};
