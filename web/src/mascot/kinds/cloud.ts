import { GREEN_TIE, ellipse, type KindArt } from "../kind";

export const cloud: KindArt = {
  name: "Nuvem",
  body: "#e6f1ff",
  inner: "#ff9fc0",
  eye: "#25304a",
  ...GREEN_TIE,
  rim: true,
  shape: "M27 85 A13.5 13.5 0 0 1 18.5 60 A16 16 0 0 1 35 38 A19 19 0 0 1 68 36 A16 16 0 0 1 82.5 60 A13.5 13.5 0 0 1 74 85 Z",
  marks: [
    { d: ellipse(29, 69, 4.2, 2.7), fill: "inner", opacity: 0.6 },
    { d: ellipse(71, 69, 4.2, 2.7), fill: "inner", opacity: 0.6 },
  ],
  fit: { top: 27.5, chin: 84.75, temple: 17.25, side: 18.25, neck: 13, helmet: [66.25, 39.8], hair: [1, 5] },
  colors: {
    chuva: { body: "#9aa6bd", eye: "#1b2233" },
  },
};
