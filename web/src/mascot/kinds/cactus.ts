import { RED_TIE, circle, type KindArt } from "../kind";

const FLOWER = [circle(50, 19, 3.4), circle(45.6, 22.4, 3.4), circle(54.4, 22.4, 3.4), circle(47.2, 27, 3.4), circle(52.8, 27, 3.4)].join(" ");

export const cactus: KindArt = {
  name: "Cacto",
  body: "#3f9e5c",
  inner: "#5cbf78",
  accent: "#ff6fa5",
  eye: "#f8f8fa",
  ...RED_TIE,
  rim: false,
  shape: "M29 46 C29 32 38 24 50 24 C62 24 71 32 71 46 V84 Q71 89 66 89 H34 Q29 89 29 84 Z",
  ear: {
    path: "M31 67 H22 C17 67 15 64 15 59 V46 C15 43 17 41 19.5 41 C22 41 24 43 24 46 V58 H31 Z",
    pivot: [30, 62],
    sway: 0.45,
  },
  top: { path: FLOWER, fill: "accent", parts: [{ d: circle(50, 23.4, 2.2), fill: "#ffd84a" }], pivot: [50, 27], sway: 0.6, front: true },
  marks: [
    { d: "M39.5 30 V89 M50 24 V89 M60.5 30 V89", stroke: "inner", width: 1.6, opacity: 0.8 },
    { d: "M33 38 l-2 -1.4 M68 40 l2 -1.4 M33 74 l-2 -1.2 M67 72 l2 -1.2 M46 80 l-1.2 1.6 M55 84 l1.2 1.6", stroke: "#e9f6d4", width: 1.2 },
  ],
  hat: -4,
};
