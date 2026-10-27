export const MASCOT_KINDS = [
  "wolf",
  "cat",
  "fox",
  "bunny",
  "bear",
  "frog",
  "penguin",
  "owl",
  "panda",
  "koala",
  "axolotl",
  "octopus",
  "bee",
  "robot",
  "alien",
  "ghost",
  "mushroom",
  "cactus",
  "strawberry",
  "avocado",
  "cloud",
  "drop",
  "flame",
  "planet",
  "slime",
  "popcorn",
  "onigiri",
  "dice",
] as const;

export type MascotKind = (typeof MASCOT_KINDS)[number];
export type MascotExpression = "idle" | "listening" | "thinking" | "speaking" | "happy" | "error";
export const MASCOT_EXPRESSIONS: MascotExpression[] = ["idle", "listening", "thinking", "speaking", "happy", "error"];

export const MASCOT_ACCESSORIES = [
  { id: "bowtie", label: "Gravata-borboleta" },
  { id: "headphones", label: "Fone" },
  { id: "cat-headphones", label: "Fone de gato" },
  { id: "sunglasses", label: "Óculos escuros" },
  { id: "round-glasses", label: "Óculos redondos" },
  { id: "beanie", label: "Gorro" },
  { id: "cap", label: "Boné" },
  { id: "crown", label: "Coroa" },
  { id: "bow", label: "Laço" },
  { id: "flower", label: "Flor" },
  { id: "scarf", label: "Cachecol" },
  { id: "space-helmet", label: "Capacete espacial" },
  { id: "none", label: "Nenhum" },
] as const;

export type MascotAccessory = (typeof MASCOT_ACCESSORIES)[number]["id"];

export type MascotProps = {
  kind: MascotKind;
  expression: MascotExpression;
  color?: string;
  level?: () => number;
  size?: number;
  lookAt?: { x: number; y: number } | null;
  className?: string;
  title?: string;
  accessory?: MascotAccessory;
  still?: boolean;
};
