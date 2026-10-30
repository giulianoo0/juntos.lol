import { GREEN_TIE, circle, ellipse, type KindArt } from "../kind";

/** The nose: the eyes stay clear of it whichever way they look. */
export const NOSE = { cx: 50, cy: 71, rx: 5.8, ry: 7.8 } as const;

export const koala: KindArt = {
  name: "Coala",
  body: "#9aa4ae",
  inner: "#efe4ea",
  tip: "#2b2b31",
  eye: "#1f2126",
  ...GREEN_TIE,
  rim: false,
  ear: { path: circle(22, 41, 14.5), inner: circle(23.5, 42.5, 8.5), pivot: [29, 47], sway: 0.5 },
  marks: [{ d: ellipse(NOSE.cx, NOSE.cy, NOSE.rx, NOSE.ry), fill: "tip" }],
  socket: { box: [31.5, 40, 47, 61.8] },
  fit: { helmet: [52.25, 35.7] },
};
