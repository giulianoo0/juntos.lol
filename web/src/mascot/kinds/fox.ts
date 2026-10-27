import { EYE_DARK, EYE_WHITE, GREEN_TIE, type KindArt } from "../kind";

export const fox: KindArt = {
  name: "Raposa",
  body: "#e65719",
  inner: "#f9dfcb",
  tip: "#2a1e1a",
  eye: EYE_WHITE,
  ...GREEN_TIE,
  rim: false,
  ear: {
    path: "M19 48 L21.5 5 L46.5 29 L40 50 Z",
    inner: "M27 39 L26.6 17 L39.4 30.2 Z",
    tip: "M21.5 5 L20.8 18.5 L29.8 13 Z",
    pivot: [33, 38],
  },
  colors: {
    artico: { body: "#eef1f6", inner: "#cfd9e8", tip: "#8f9db3", eye: EYE_DARK, rim: true },
  },
};
