import { GREEN_TIE, ellipse, type KindArt } from "../kind";

export const drop: KindArt = {
  name: "Gota",
  body: "#3fb8ff",
  inner: "#bfe8ff",
  eye: "#0f2a44",
  ...GREEN_TIE,
  rim: false,
  shape: "M50 14 C58 28 78 42 78 62 A28 28 0 0 1 22 62 C22 42 42 28 50 14 Z",
  hat: -9,
  marks: [
    { d: "M70 64 Q70 74 62 80", stroke: "inner", width: 3.4, opacity: 0.8 },
    { d: ellipse(31, 69, 4, 2.6), fill: "#ff9fc0", opacity: 0.55 },
    { d: ellipse(69, 69, 4, 2.6), fill: "#ff9fc0", opacity: 0.55 },
  ],
};
