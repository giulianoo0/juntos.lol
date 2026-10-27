import { GREEN_TIE, circle, roundRect, type KindArt } from "../kind";

export const dice: KindArt = {
  name: "Dado",
  body: "#e8394a",
  inner: "#fff6f2",
  eye: "#fff6f2",
  ...GREEN_TIE,
  rim: false,
  shape: roundRect(19, 29, 62, 60, 12),
  marks: [{ d: [circle(30.5, 40, 4), circle(69.5, 40, 4), circle(30.5, 77.5, 4), circle(69.5, 77.5, 4), circle(50, 77.5, 4)].join(" "), fill: "inner" }],
  colors: {
    azul: { body: "#3b6cff" },
    preto: { body: "#25262d", rim: true },
  },
};
