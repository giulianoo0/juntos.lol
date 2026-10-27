import { EYE_WHITE, GREEN_TIE, capsule, ellipse, type KindArt } from "../kind";

const SEEDS = [
  [29, 44, -20],
  [71, 44, 20],
  [23, 58, -10],
  [77, 58, 10],
  [30, 72, -16],
  [70, 72, 16],
  [41, 80, -8],
  [59, 80, 8],
  [50, 87, 0],
  [50, 39, 0],
] as const;

export const strawberry: KindArt = {
  name: "Morango",
  body: "#ee3d4f",
  inner: "#ffe08a",
  accent: "#3fae4f",
  eye: EYE_WHITE,
  ...GREEN_TIE,
  rim: false,
  shape: "M50 91 C34 87 18 71 18 52 C18 38 29 31 39 32.5 C43 33.2 46.5 34.6 50 34.6 C53.5 34.6 57 33.2 61 32.5 C71 31 82 38 82 52 C82 71 66 87 50 91 Z",
  top: {
    path: "M50 37 Q42 40.5 34 39.5 Q38 34.4 44 33 Q37 30 33.6 25 Q42 24.8 47.4 30 Q47 24 50 19.6 Q53 24 52.6 30 Q58 24.8 66.4 25 Q63 30 56 33 Q62 34.4 66 39.5 Q58 40.5 50 37 Z",
    fill: "accent",
    parts: [{ d: capsule(50, 24, 52.6, 13.6, 1.8), fill: "#2f8a3d" }],
    pivot: [50, 36],
    sway: 0.4,
    front: true,
  },
  marks: SEEDS.map(([x, y, deg]) => ({ d: ellipse(x, y, 1.2, 2, deg), fill: "inner" })),
  colors: {
    branco: { body: "#fbe9ec", inner: "#ff6f86", eye: "#3a1a22" },
  },
};
