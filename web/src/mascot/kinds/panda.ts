import { EYE_WHITE, GREEN_TIE, ellipse, type KindArt } from "../kind";

/** The left eye's patch, mirrored for the right. */
export const PATCH = { cx: 37.5, cy: 57, rx: 9.2, ry: 13, deg: 40 } as const;

const PATCHES = `${ellipse(PATCH.cx, PATCH.cy, PATCH.rx, PATCH.ry, PATCH.deg)} ${ellipse(100 - PATCH.cx, PATCH.cy, PATCH.rx, PATCH.ry, -PATCH.deg)}`;

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
  socket: { box: [33.4, 49.6, 41.6, 64.4], scale: 0.62 },
  front: [{ d: ellipse(50, 68.6, 3.6, 2.5), fill: "tip" }],
  fit: { helmet: [53.25, 34.9] },
};
