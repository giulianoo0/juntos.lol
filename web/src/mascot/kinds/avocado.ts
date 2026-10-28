import { RED_TIE, circle, ellipse, type KindArt } from "../kind";

const FLESH = "M50 25.5 C59.5 25.5 64.5 35 68 46 C73.5 59 77.5 66 77.5 72.5 C77.5 82 66 85.5 50 85.5 C34 85.5 22.5 82 22.5 72.5 C22.5 66 26.5 59 32 46 C35.5 35 40.5 25.5 50 25.5 Z";

export const avocado: KindArt = {
  name: "Abacate",
  body: "#2f5b2a",
  inner: "#d7e591",
  tip: "#8a5732",
  eye: "#22301a",
  ...RED_TIE,
  rim: true,
  shape: "M50 20 C62 20 68 32 72 44 C78 58 82 65 82 72 C82 85 68 90 50 90 C32 90 18 85 18 72 C18 65 22 58 28 44 C32 32 38 20 50 20 Z",
  marks: [
    { d: FLESH, fill: "inner" },
    { d: circle(50, 74.5, 9.5), fill: "tip" },
    { d: ellipse(46.4, 71, 2.6, 1.6, -30), fill: "#b07c50" },
    { d: ellipse(32, 64, 3.8, 2.4), fill: "#ff9a8a", opacity: 0.55 },
    { d: ellipse(68, 64, 3.8, 2.4), fill: "#ff9a8a", opacity: 0.55 },
  ],
  eyeClip: FLESH,
  socket: { box: [31, 46.5, 47.5, 65.5] },
  hat: -4,
  hatScale: 0.76,
  fit: { top: 20, chin: 89.75, temple: 24.25, side: 21, neck: 21.75, helmet: [57.5, 37.7], hair: [3, 4] },
};
