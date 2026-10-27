import { EYE_DARK, EYE_WHITE, GREEN_TIE, type KindArt } from "../kind";

export const bunny: KindArt = {
  name: "Coelho",
  body: "#9470cd",
  inner: "#dfb4da",
  eye: EYE_WHITE,
  ...GREEN_TIE,
  rim: false,
  ear: {
    path: "M32 42 C26.5 26 28.5 1.5 37.5 0.5 C46.5 1.5 47 26 43 42 Z",
    inner: "M35 33 C32 23 33.4 8 37.6 7 C41.8 8 42.6 23 40.2 33 Z",
    pivot: [37.5, 38],
  },
  colors: {
    branco: { body: "#f3f0f6", inner: "#f7c3d6", eye: EYE_DARK, rim: true },
  },
};
