import { GREEN_TIE, type KindArt } from "../kind";

const RING = { back: "M12.83 73.9 A38 9 -12 0 1 87.17 58.1", front: "M12.83 73.9 A38 9 -12 0 0 87.17 58.1" } as const;

export const planet: KindArt = {
  name: "Planeta",
  body: "#7a5cf0",
  inner: "#957cf6",
  accent: "#ffd36b",
  eye: "#f8f8fa",
  ...GREEN_TIE,
  rim: false,
  back: [{ d: RING.back, stroke: "accent", width: 4.4 }],
  marks: [
    { d: "M16 37 Q50 31 84 37", stroke: "inner", width: 4.6 },
    { d: "M16 82 Q50 76 84 82", stroke: "inner", width: 4.6 },
  ],
  front: [{ d: RING.front, stroke: "accent", width: 4.4 }],
  fit: { helmet: [62, 34.3] },
  colors: {
    verde: { body: "#2fb59a", inner: "#4ccbb0", accent: "#ffd36b" },
    terra: { body: "#e58e4f", inner: "#f0a86c", accent: "#bfe2ff" },
  },
};
