import { RED_TIE, circle, ellipse, type KindArt } from "../kind";

export const slime: KindArt = {
  name: "Slime",
  body: "#5b7cff",
  inner: "#ffffff",
  eye: "#f8f8fa",
  ...RED_TIE,
  rim: false,
  shape: "M50 23 C55 33 66 40 74 47 C81 54 85 64 85 74 C85 85 72 89 50 89 C28 89 15 85 15 74 C15 64 19 54 26 47 C34 40 45 33 50 23 Z",
  marks: [
    { d: ellipse(25, 70, 2.6, 5.6, 28), fill: "inner", opacity: 0.45 },
    { d: circle(28.6, 61, 1.5), fill: "inner", opacity: 0.45 },
    { d: circle(68, 77, 2.4), fill: "inner", opacity: 0.28 },
    { d: circle(74, 68, 1.4), fill: "inner", opacity: 0.28 },
  ],
  colors: {
    verde: { body: "#7ed957", eye: "#173010" },
    rosa: { body: "#ff7ab6" },
  },
};
