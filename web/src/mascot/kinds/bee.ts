import { BLUE_TIE, capsule, circle, ellipse, type KindArt } from "../kind";

export const bee: KindArt = {
  name: "Abelha",
  body: "#ffc83a",
  inner: "#ff9f6e",
  tip: "#2b2420",
  eye: "#2b2420",
  ...BLUE_TIE,
  rim: true,
  back: [
    { d: ellipse(25, 35, 9, 14, -32), fill: "#eaf5ff", stroke: "#b8d3ea", width: 1.2 },
    { d: ellipse(75, 35, 9, 14, 32), fill: "#eaf5ff", stroke: "#b8d3ea", width: 1.2 },
  ],
  ear: { path: `${capsule(41, 31, 33, 16, 1.4)} ${circle(32, 14, 3.6)}`, fill: "tip", pivot: [41, 31], antenna: true },
  marks: [
    { d: "M18 70 Q50 77 82 70 L82 78.5 Q50 85.5 18 78.5 Z", fill: "tip" },
    { d: "M18 86 Q50 93 82 86 L82 96 Q50 103 18 96 Z", fill: "tip" },
    { d: ellipse(28, 63, 4, 2.6), fill: "inner", opacity: 0.7 },
    { d: ellipse(72, 63, 4, 2.6), fill: "inner", opacity: 0.7 },
  ],
};
