import { EYE_DARK, EYE_WHITE, GREEN_TIE, type KindArt } from "../kind";

export const bear: KindArt = {
  name: "Urso",
  body: "#865634",
  inner: "#a67c5b",
  eye: EYE_WHITE,
  ...GREEN_TIE,
  rim: true,
  ear: {
    path: "M17 33 A11 11 0 1 1 39 33 A11 11 0 1 1 17 33 Z",
    inner: "M22.5 33 A5.5 5.5 0 1 1 33.5 33 A5.5 5.5 0 1 1 22.5 33 Z",
    pivot: [30, 40],
  },
  fit: { helmet: [53.25, 34.9] },
  colors: {
    polar: { body: "#f1efe9", inner: "#dcd5c8", eye: EYE_DARK },
  },
};
