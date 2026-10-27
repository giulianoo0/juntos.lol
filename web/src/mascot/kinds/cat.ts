import { EYE_WHITE, GREEN_TIE, type KindArt } from "../kind";

export const cat: KindArt = {
  name: "Gato",
  body: "#d87a1f",
  inner: "#f4b0af",
  eye: EYE_WHITE,
  ...GREEN_TIE,
  rim: false,
  ear: {
    path: "M21 47 L23.4 17.6 Q23.9 14.5 26.4 16.2 L46 30 L40 50 Z",
    inner: "M27.2 37.5 L27.8 22.2 L39.4 30.8 Z",
    pivot: [33, 38],
  },
  fit: { helmet: [52, 35.9] },
  colors: {
    preto: { body: "#26262c", inner: "#4a4a55", rim: true },
    cinza: { body: "#8d909b", inner: "#f2b9b9" },
  },
};
