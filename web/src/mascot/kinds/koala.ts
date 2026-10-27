import { GREEN_TIE, circle, ellipse, type KindArt } from "../kind";

export const koala: KindArt = {
  name: "Coala",
  body: "#9aa4ae",
  inner: "#efe4ea",
  tip: "#2b2b31",
  eye: "#1f2126",
  ...GREEN_TIE,
  rim: false,
  ear: { path: circle(22, 41, 14.5), inner: circle(23.5, 42.5, 8.5), pivot: [29, 47], sway: 0.5 },
  marks: [{ d: ellipse(50, 69, 6.4, 8.6), fill: "tip" }],
  fit: { helmet: [52.25, 35.7] },
};
