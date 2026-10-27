import { EYE_WHITE, GREEN_TIE, ellipse, type KindArt } from "../kind";

const PATCHES = `${ellipse(37.5, 57, 8.4, 12.4, 42)} ${ellipse(62.5, 57, 8.4, 12.4, -42)}`;

export const panda: KindArt = {
  name: "Panda",
  body: "#f5f3ef",
  inner: "#1d1d22",
  tip: "#1d1d22",
  eye: EYE_WHITE,
  ...GREEN_TIE,
  rim: true,
  ear: {
    path: "M17 33 A11 11 0 1 1 39 33 A11 11 0 1 1 17 33 Z",
    fill: "tip",
    pivot: [30, 40],
  },
  marks: [{ d: PATCHES, fill: "tip" }],
  eyeClip: PATCHES,
  front: [{ d: ellipse(50, 68.6, 3.6, 2.5), fill: "tip" }],
};
