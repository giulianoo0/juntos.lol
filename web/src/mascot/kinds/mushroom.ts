import { GREEN_TIE, circle, ellipse, roundRect, type KindArt } from "../kind";

export const mushroom: KindArt = {
  name: "Cogumelo",
  body: "#f4e3c6",
  inner: "#ff9fa8",
  accent: "#e5463c",
  eye: "#2b1f17",
  ...GREEN_TIE,
  rim: false,
  shape: roundRect(25, 34, 50, 55, 15),
  top: {
    path: "M8 38 C8 17 28 3 50 3 C72 3 92 17 92 38 C92 43 87 44.5 82 43.2 C68 39.4 32 39.4 18 43.2 C13 44.5 8 43 8 38 Z",
    fill: "accent",
    parts: [
      { d: circle(31, 18, 5.6), fill: "#fff4e4" },
      { d: circle(53, 10.5, 4.2), fill: "#fff4e4" },
      { d: circle(72, 21, 6.2), fill: "#fff4e4" },
      { d: circle(17.5, 33, 2.8), fill: "#fff4e4" },
      { d: circle(85, 33, 2.6), fill: "#fff4e4" },
      { d: circle(48, 27, 2.4), fill: "#fff4e4" },
    ],
    pivot: [50, 42],
    sway: 0.25,
    front: true,
    keep: true,
  },
  marks: [
    { d: ellipse(32, 66, 4, 2.6), fill: "inner", opacity: 0.7 },
    { d: ellipse(68, 66, 4, 2.6), fill: "inner", opacity: 0.7 },
  ],
  hat: -29,
  hatScale: 0.68,
  fit: { top: 34, chin: 88.75, temple: 25, side: 25, neck: 26, helmet: [55.25, 36.8], band: 3 },
  colors: {
    azul: { accent: "#4f7bff" },
  },
};
