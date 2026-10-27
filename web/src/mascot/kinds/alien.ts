import { RED_TIE, capsule, circle, ellipse, type KindArt } from "../kind";

export const alien: KindArt = {
  name: "Alien",
  body: "#5fd8a8",
  inner: "#46b88c",
  tip: "#ff7ad9",
  eye: "#10261d",
  ...RED_TIE,
  rim: false,
  shape: "M50 23 C70 23 83 35 83 51 C83 70 66 89 50 89 C34 89 17 70 17 51 C17 35 30 23 50 23 Z",
  ear: { path: `${capsule(39, 27, 32, 12, 1.4)} ${circle(31, 10, 3.6)}`, tip: circle(31, 10, 3.6), pivot: [39, 27] },
  marks: [
    { d: circle(31, 36, 2.2), fill: "inner" },
    { d: circle(69, 33, 1.6), fill: "inner" },
    { d: circle(74, 44, 2.6), fill: "inner" },
    { d: ellipse(29, 68, 4, 2.6), fill: "#ff9ccf", opacity: 0.6 },
    { d: ellipse(71, 68, 4, 2.6), fill: "#ff9ccf", opacity: 0.6 },
  ],
  hat: -4,
};
