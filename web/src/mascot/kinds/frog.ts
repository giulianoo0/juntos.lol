import { RED_TIE, circle, ellipse, type KindArt } from "../kind";

export const frog: KindArt = {
  name: "Sapo",
  body: "#6cc24a",
  inner: "#d6f0a0",
  eye: "#18260f",
  ...RED_TIE,
  rim: false,
  shape: ellipse(50, 62, 34, 26),
  ear: { path: circle(31, 41, 11), pivot: [34, 48], sway: 0.35 },
  marks: [
    { d: ellipse(50, 88, 24, 13), fill: "inner" },
    { d: ellipse(27, 68, 4.6, 3), fill: "#ff8fa3", opacity: 0.6 },
    { d: ellipse(73, 68, 4.6, 3), fill: "#ff8fa3", opacity: 0.6 },
  ],
  fit: { top: 36, temple: 18.5, side: 16, neck: 25.25, helmet: [61.75, 34.1] },
  colors: {
    azul: { body: "#3f8cff", inner: "#bcd6ff", eye: "#0e1b33" },
  },
};
