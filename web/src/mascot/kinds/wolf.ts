import { EYE_WHITE, GREEN_TIE, type KindArt } from "../kind";

export const wolf: KindArt = {
  name: "Lobo",
  body: "#17181d",
  inner: "#2c2d34",
  eye: EYE_WHITE,
  ...GREEN_TIE,
  rim: true,
  ear: {
    path: "M24 43 L25 3 L44.8 28.5 L40 50 Z",
    inner: "M29.2 36.5 L28 13.5 L40.2 29.2 Z",
    pivot: [34, 37],
  },
};
