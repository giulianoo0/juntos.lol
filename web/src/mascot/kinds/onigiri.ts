import { EYE_DARK, GREEN_TIE, ellipse, type KindArt } from "../kind";

export const onigiri: KindArt = {
  name: "Onigiri",
  body: "#f7f4ec",
  inner: "#ff9fb4",
  tip: "#1f3a2c",
  eye: EYE_DARK,
  ...GREEN_TIE,
  rim: true,
  shape: "M50 20 C60 20 66 28 72 38 L84 66 C89 80 82 89 70 89 H30 C18 89 11 80 16 66 L28 38 C34 28 40 20 50 20 Z",
  marks: [
    { d: "M35 69 H65 V96 H35 Z", fill: "tip" },
    { d: ellipse(27, 64, 3.8, 2.4), fill: "inner", opacity: 0.6 },
    { d: ellipse(73, 64, 3.8, 2.4), fill: "inner", opacity: 0.6 },
    { d: `${ellipse(44, 32, 0.9, 1.6, 30)} ${ellipse(57, 36, 0.9, 1.6, -20)}`, fill: "#d8ccb2" },
  ],
  hat: -6,
};
