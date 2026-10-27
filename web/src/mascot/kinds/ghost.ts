import { GREEN_TIE, ellipse, type KindArt } from "../kind";

export const ghost: KindArt = {
  name: "Fantasma",
  body: "#efebff",
  inner: "#ff9fc0",
  eye: "#2a2440",
  ...GREEN_TIE,
  rim: true,
  shape: "M21 56 C21 38 34 26 50 26 C66 26 79 38 79 56 L79 88 Q72.5 81 65.5 87.5 Q58 81 50 87.5 Q42 81 34.5 87.5 Q27.5 81 21 88 Z",
  marks: [
    { d: ellipse(30, 66, 4.2, 2.7), fill: "inner", opacity: 0.6 },
    { d: ellipse(70, 66, 4.2, 2.7), fill: "inner", opacity: 0.6 },
  ],
  hat: -2,
};
