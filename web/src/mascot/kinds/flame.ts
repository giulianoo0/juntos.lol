import { BLUE_TIE, type KindArt } from "../kind";

export const flame: KindArt = {
  name: "Chama",
  body: "#ff7a1c",
  inner: "#ffd23f",
  eye: "#3a1406",
  ...BLUE_TIE,
  rim: false,
  shape: "M50 12 C54 22 62 28 70 38 C77 47 80 56 80 64 C80 79 67 89 50 89 C33 89 20 79 20 64 C20 52 26 44 32 36 C33 41 35 44 38 45 C37 33 42 22 50 12 Z",
  top: { path: "M66 36 C63.6 27 67.6 19 72.6 12 C78 21 79.6 31 72 39.6 Z", pivot: [69, 39] },
  marks: [{ d: "M50 65 C55 70.4 62 74 62 80 C62 85 57 88.4 50 88.4 C43 88.4 38 85 38 80 C38 74 45 70.4 50 65 Z", fill: "inner" }],
  hat: -10,
  colors: {
    azul: { body: "#3d7bff", inner: "#9fe1ff", eye: "#0c1838" },
  },
};
