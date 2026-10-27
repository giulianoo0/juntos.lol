import { EYE_DARK, GREEN_TIE, circle, type KindArt } from "../kind";

const DISCS = `${circle(38.5, 54, 13)} ${circle(61.5, 54, 13)}`;

export const owl: KindArt = {
  name: "Coruja",
  body: "#8a6447",
  inner: "#f2dcb8",
  tip: "#6a4a33",
  accent: "#f2a33a",
  eye: EYE_DARK,
  ...GREEN_TIE,
  rim: false,
  ear: {
    path: "M22 44 L20.5 19 Q21 16 23.6 17.6 L41 31 Z",
    inner: "M25 37 L24.4 23.6 L34.4 31.4 Z",
    pivot: [30, 38],
    sway: 0.7,
  },
  marks: [
    { d: DISCS, fill: "inner" },
    { d: "M38 79 L42 82.6 L46 79 M54 79 L58 82.6 L62 79 M46 85.4 L50 89 L54 85.4", stroke: "tip", width: 1.8 },
  ],
  eyeClip: DISCS,
  front: [{ d: "M46.6 65.4 Q50 64 53.4 65.4 L50.8 71.6 Q50 72.8 49.2 71.6 Z", fill: "accent" }],
};
