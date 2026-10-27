import { EYE_DARK, GREEN_TIE, ellipse, type KindArt } from "../kind";

const MASK = "M50 44 C45 35.5 30 35.5 27 48 C24 62 34 76 50 82 C66 76 76 62 73 48 C70 35.5 55 35.5 50 44 Z";

export const penguin: KindArt = {
  name: "Pinguim",
  body: "#27334f",
  inner: "#f7f5ef",
  accent: "#ffa53a",
  eye: EYE_DARK,
  ...GREEN_TIE,
  rim: true,
  back: [
    { d: "M23 60 Q11 69 14 83 Q22 77 27 70 Z", fill: "body" },
    { d: "M77 60 Q89 69 86 83 Q78 77 73 70 Z", fill: "body" },
  ],
  marks: [
    { d: MASK, fill: "inner" },
    { d: ellipse(31, 66, 4, 2.6), fill: "#ff9eb1", opacity: 0.55 },
    { d: ellipse(69, 66, 4, 2.6), fill: "#ff9eb1", opacity: 0.55 },
  ],
  eyeClip: MASK,
  front: [{ d: "M45.4 63.2 Q50 61.4 54.6 63.2 L50.9 68.8 Q50 70 49.1 68.8 Z", fill: "accent" }],
  fit: { helmet: [67, 39.5] },
};
