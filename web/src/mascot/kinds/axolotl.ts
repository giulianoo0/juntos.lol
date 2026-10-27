import { BLUE_TIE, EYE_DARK, capsule, ellipse, type KindArt } from "../kind";

const GILLS = [capsule(28, 45, 13, 28, 3.6), capsule(25.5, 52, 8, 47, 3.6), capsule(26.5, 58, 10.5, 65.5, 3.4)].join(" ");

export const axolotl: KindArt = {
  name: "Axolote",
  body: "#ffb3c9",
  inner: "#ff7fa6",
  accent: "#ff6f9a",
  eye: EYE_DARK,
  ...BLUE_TIE,
  rim: false,
  shape: ellipse(50, 60, 32, 27.5),
  ear: { path: GILLS, fill: "accent", pivot: [28, 52] },
  marks: [
    { d: ellipse(29, 67, 4.4, 2.8), fill: "inner", opacity: 0.6 },
    { d: ellipse(71, 67, 4.4, 2.8), fill: "inner", opacity: 0.6 },
  ],
  colors: {
    dourado: { body: "#ffd27a", inner: "#ff9f5a", accent: "#ff8f3d" },
    noite: { body: "#4c4660", inner: "#8a7fb0", accent: "#ff6f9a", eye: "#f8f8fa" },
  },
};
