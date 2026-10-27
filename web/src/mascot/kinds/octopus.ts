import { EYE_WHITE, GREEN_TIE, circle, type KindArt } from "../kind";

export const octopus: KindArt = {
  name: "Polvo",
  body: "#f0644f",
  inner: "#ffb09f",
  eye: EYE_WHITE,
  ...GREEN_TIE,
  rim: false,
  shape:
    "M19 58 C19 38 33 25 50 25 C67 25 81 38 81 58 L81 81 Q77 89 72 83 Q66.5 91 61 84 Q55.5 91.5 50 85 Q44.5 91.5 39 84 Q33.5 91 28 83 Q23 89 19 81 Z",
  back: [
    { d: "M24 74 C14 76 9 84 13 89 C16 92.5 21 90 19 86.5", stroke: "body", width: 6 },
    { d: "M76 74 C86 76 91 84 87 89 C84 92.5 79 90 81 86.5", stroke: "body", width: 6 },
  ],
  marks: [
    { d: circle(30, 39, 3.2), fill: "inner" },
    { d: circle(67, 34, 2.4), fill: "inner" },
    { d: circle(74, 48, 2), fill: "inner" },
    { d: circle(24.5, 51, 1.8), fill: "inner" },
    { d: circle(57, 30, 1.5), fill: "inner" },
    { d: `${circle(33.5, 82, 1.3)} ${circle(44.5, 83, 1.3)} ${circle(55.5, 83, 1.3)} ${circle(66.5, 82, 1.3)}`, fill: "inner" },
  ],
  hat: -2,
  fit: { top: 25, chin: 85, temple: 19.5, side: 19, neck: 19, helmet: [64.25, 39.4] },
  colors: {
    roxo: { body: "#9a5ad8", inner: "#c99af0" },
  },
};
