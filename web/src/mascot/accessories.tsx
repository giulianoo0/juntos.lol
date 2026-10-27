import { BEANIE, HAIR, HATS, HEADPHONES, HELMET, ROUND_GLASSES, SUNGLASSES, headphonesLive } from "./accessory-geometry";
import { BOWTIE, BRAND_GREEN, type KindArt } from "./kind";
import type { MascotAccessory, MascotExpression } from "./types";

const GRAPHITE = "#2a2b33";
/** Where the hats meet the head, the point they shrink toward. */
const HAT_BRIM = 44;
const GRAPHITE_LIGHT = "#3a3c46";

function BowTie({ art }: { art: KindArt }) {
  return (
    <g data-accessory="bowtie" data-part="accessory">
      <path d={BOWTIE.left} fill={art.bowtie} />
      <path d={BOWTIE.right} fill={art.bowtie} />
      <rect {...BOWTIE.knot} fill={art.knot} />
    </g>
  );
}

const CAT_EAR = { outer: "M22.6 42 L24.6 20.5 L38.6 33.6 Z", inner: "M26.2 35.6 L27.2 26.4 L33.6 32.4 Z" } as const;

function Headphones({ id, expression, dark }: { id: "headphones" | "cat-headphones"; expression: MascotExpression; dark: boolean }) {
  const live = headphonesLive(expression);
  const cat = id === "cat-headphones";
  const band = cat ? "#f6b3cf" : dark ? "#8a8d99" : GRAPHITE;
  const shine = cat ? "#ffe3ef" : dark ? "#b4b7c2" : GRAPHITE_LIGHT;
  const light = cat ? "#ff4f97" : BRAND_GREEN;
  const opacity = live ? HEADPHONES.light.live : HEADPHONES.light.idle;
  return (
    <g data-accessory={id} data-part="accessory" data-live={live || undefined}>
      {cat
        ? [false, true].map((mirror) => (
            <g key={String(mirror)} transform={mirror ? "translate(100 0) scale(-1 1)" : undefined}>
              <path d={CAT_EAR.outer} fill={band} strokeLinejoin="round" stroke={band} strokeWidth={2} />
              <path d={CAT_EAR.inner} fill="#ff7fb0" strokeLinejoin="round" stroke="#ff7fb0" strokeWidth={1} />
            </g>
          ))
        : null}
      <path d="M19.5 60 C19.5 22.5 80.5 22.5 80.5 60" fill="none" stroke={band} strokeWidth={4.2} strokeLinecap="round" />
      <path d="M22.4 47 C26 32 74 32 77.6 47" fill="none" stroke={shine} strokeWidth={1.2} strokeLinecap="round" opacity={0.8} />
      {HEADPHONES.cups.map((cup) => (
        <rect key={cup.x} {...cup} rx={4} fill={band} />
      ))}
      <rect data-light="" x={15} y={54.5} width={2.6} height={12} rx={1.3} fill={light} opacity={opacity} />
      <rect data-light="" x={82.4} y={54.5} width={2.6} height={12} rx={1.3} fill={light} opacity={opacity} />
    </g>
  );
}

/**
 * Tinted lenses with a white glint: the eyes stay inside them (accessory-geometry.ts) and show through,
 * dimmed. On the dark kinds the frame turns silver so the shape reads at 32 px.
 */
function Sunglasses({ dark }: { dark: boolean }) {
  const frame = dark ? "#c4c7d1" : "#0b0b0f";
  return (
    <g data-accessory="sunglasses" data-part="accessory">
      <path d="M20.5 52.5 L30 51.5 M70 51.5 L79.5 52.5" stroke={frame} strokeWidth={2.8} strokeLinecap="round" />
      <path d="M48 52.8 Q50 50.2 52 52.8" fill="none" stroke={frame} strokeWidth={2.8} strokeLinecap="round" />
      <rect data-lens="left" {...SUNGLASSES.left} fill="#0b0b0f" fillOpacity={SUNGLASSES.tint} stroke={frame} strokeWidth={SUNGLASSES.stroke} />
      <rect data-lens="right" {...SUNGLASSES.right} fill="#0b0b0f" fillOpacity={SUNGLASSES.tint} stroke={frame} strokeWidth={SUNGLASSES.stroke} />
      <path d="M33.5 49.2 L39.5 49.2 M55.5 49.2 L61.5 49.2" stroke="#ffffff" strokeOpacity={0.8} strokeWidth={2.2} strokeLinecap="round" />
    </g>
  );
}

/** Clear round lenses: the eyes shrink into them and keep their color. */
function RoundGlasses({ dark }: { dark: boolean }) {
  const frame = dark ? "#e6c27a" : "#b5812c";
  const { left, right, stroke } = ROUND_GLASSES;
  return (
    <g data-accessory="round-glasses" data-part="accessory">
      <path d="M21 51.5 L30.2 52.6 M69.8 52.6 L79 51.5" stroke={frame} strokeWidth={2.2} strokeLinecap="round" />
      <path d="M48.6 52.4 Q50 50.6 51.4 52.4" fill="none" stroke={frame} strokeWidth={2} strokeLinecap="round" />
      <rect data-lens="left" {...left} fill="#ffffff" fillOpacity={0.12} stroke={frame} strokeWidth={stroke} />
      <rect data-lens="right" {...right} fill="#ffffff" fillOpacity={0.12} stroke={frame} strokeWidth={stroke} />
      <path d="M33.4 49.6 Q35 47.2 37.6 46.6 M54.4 49.6 Q56 47.2 58.6 46.6" fill="none" stroke="#ffffff" strokeOpacity={0.75} strokeWidth={1.6} strokeLinecap="round" />
    </g>
  );
}

/** Sits above the eyes: the brim ends where the eyes' frame begins. */
function Beanie() {
  return (
    <g data-accessory="beanie" data-part="accessory" transform={`translate(0 ${BEANIE.lift})`}>
      <path d="M21.5 46 C21.5 22 78.5 22 78.5 46 Z" fill="#c8403a" />
      <path d="M31 30 L31 44 M40.5 26.2 L40.5 44 M50 25 L50 44 M59.5 26.2 L59.5 44 M69 30 L69 44" stroke="#a8322d" strokeWidth={1.4} strokeLinecap="round" />
      <rect x={BEANIE.brim.x} y={BEANIE.brim.y - BEANIE.lift} width={BEANIE.brim.width} height={BEANIE.brim.height} rx={4.5} fill="#e8e1d4" />
      <path d="M24 45 L76 45" stroke="#d3cab9" strokeWidth={1.2} strokeDasharray="2 2.6" />
      <circle cx={50} cy={21.5} r={5.2} fill="#e8e1d4" />
    </g>
  );
}

function Cap() {
  return (
    <g data-accessory="cap" data-part="accessory">
      <path d="M23 43 C23 18.5 77 18.5 77 43 Z" fill="#2f6df6" />
      <path d="M50 25 V42 M37 27.6 Q33.6 34 33.4 42.4 M63 27.6 Q66.4 34 66.6 42.4" fill="none" stroke="#2457cc" strokeWidth={1.3} strokeLinecap="round" />
      <path d="M17.6 42.2 Q50 34.6 82.4 42.2 Q85 46.6 78.4 46.2 Q50 41.6 21.6 46.2 Q15 46.6 17.6 42.2 Z" fill="#1d47aa" />
      <circle cx={50} cy={24.6} r={2.3} fill="#ffffff" />
    </g>
  );
}

function Crown() {
  return (
    <g data-accessory="crown" data-part="accessory">
      <path d="M30 36 L27.6 19.4 L39.6 27.6 L50 14.4 L60.4 27.6 L72.4 19.4 L70 36 Z" fill="#f7c948" stroke="#f7c948" strokeWidth={1.6} strokeLinejoin="round" />
      <path d="M29.8 31 H70.2 L69.6 36.6 H30.4 Z" fill="#e0a12a" />
      <circle cx={27.6} cy={19.2} r={2.4} fill="#ffe08a" />
      <circle cx={72.4} cy={19.2} r={2.4} fill="#ffe08a" />
      <circle cx={50} cy={14.2} r={2.8} fill="#ffe08a" />
      <ellipse cx={50} cy={33.8} rx={2.6} ry={1.9} fill="#e8364d" />
      <circle cx={38.6} cy={33.8} r={1.5} fill="#3e8cff" />
      <circle cx={61.4} cy={33.8} r={1.5} fill="#3e8cff" />
    </g>
  );
}

function Bow() {
  return (
    <g data-accessory="bow" data-part="accessory" transform="rotate(-18 31 31)">
      <path d="M31 31 L19.8 23.6 Q15.4 31 19.8 38.4 Z" fill="#ff4f8b" stroke="#ff4f8b" strokeWidth={2.4} strokeLinejoin="round" />
      <path d="M31 31 L42.2 23.6 Q46.6 31 42.2 38.4 Z" fill="#ff4f8b" stroke="#ff4f8b" strokeWidth={2.4} strokeLinejoin="round" />
      <path d="M22.4 27.6 L27 30.4 M39.6 27.6 L35 30.4" stroke="#ff8db5" strokeWidth={1.3} strokeLinecap="round" />
      <rect x={27.4} y={27.2} width={7.2} height={7.6} rx={2.4} fill="#e23577" />
    </g>
  );
}

const PETALS = [0, 72, 144, 216, 288];

function Flower() {
  return (
    <g data-accessory="flower" data-part="accessory">
      <path d="M66 35 Q60 36 57.6 41.4 Q63.6 41.8 66 35 Z" fill="#4cb860" />
      {PETALS.map((deg) => (
        <ellipse key={deg} cx={71} cy={25} rx={3.7} ry={5.6} transform={`rotate(${deg} 71 31)`} fill="#fffaf2" stroke="#e9dccf" strokeWidth={0.8} />
      ))}
      <circle cx={71} cy={31} r={3.6} fill="#ffc531" />
      <circle cx={70} cy={30} r={1.2} fill="#ffe489" />
    </g>
  );
}

function Scarf() {
  return (
    <g data-accessory="scarf" data-part="accessory">
      <path d="M24.5 78 Q50 90.5 75.5 78 L77.5 85 Q50 99 22.5 85 Z" fill="#b8324a" />
      <path d="M58 86 L63 99.5 L70.5 97.5 L66.5 84 Z" fill="#a12a40" />
      <path d="M30 82.8 L32 89.5 M42 86 L43 93.2 M54 86.3 L54.6 93.4" stroke="#e7a6b1" strokeWidth={1.2} strokeLinecap="round" opacity={0.7} />
      <path d="M62.5 92 L68.6 90.4" stroke="#e7a6b1" strokeWidth={1.2} strokeLinecap="round" opacity={0.7} />
    </g>
  );
}

/** A point on a circle around the helmet's center; degrees, clockwise from 3 o'clock like SVG. */
function polar(r: number, deg: number) {
  const a = (deg * Math.PI) / 180;
  return `${(HELMET.cx + r * Math.cos(a)).toFixed(2)} ${(HELMET.cy + r * Math.sin(a)).toFixed(2)}`;
}

/** An arc around the helmet's center from `from`° to `to`°, the short way. */
function arc(r: number, from: number, to: number) {
  return `M${polar(r, from)} A${r} ${r} 0 0 ${to > from ? 1 : 0} ${polar(r, to)}`;
}

/** The fishbowl is centered on the face, the ears fold inside it, and the neck ring hugs the bottom of the glass. */
function SpaceHelmet({ expression }: { expression: MascotExpression }) {
  const speaking = expression === "speaking";
  const { cx, cy, r, stroke } = HELMET;
  const ring = `${arc(r, 130, 50)} L${polar(r - 6, 50)} ${arc(r - 6, 50, 130).replace(/^M[^A]+/, "")} Z`;
  return (
    <g data-accessory="space-helmet" data-part="accessory">
      <circle data-helmet="glass" cx={cx} cy={cy} r={r} fill="#cfe3ff" fillOpacity={0.07} stroke="#a3afc2" strokeOpacity={0.9} strokeWidth={stroke} />
      <path data-glint="" d={arc(r - 7, 200, 245)} fill="none" stroke="#ffffff" strokeOpacity={speaking ? HELMET.glint.speaking : HELMET.glint.idle} strokeWidth={3.4} strokeLinecap="round" />
      <path d={arc(r - 11, 176, 190)} fill="none" stroke="#ffffff" strokeOpacity={0.3} strokeWidth={2.4} strokeLinecap="round" />
      <path d={ring} fill="#9aa3b5" />
      <path d={arc(r - 3, 120, 60)} fill="none" stroke="#c9d0dc" strokeWidth={1.4} />
    </g>
  );
}

function Piece({ id, art, expression }: { id: MascotAccessory; art: KindArt; expression: MascotExpression }) {
  switch (id) {
    case "bowtie":
      return <BowTie art={art} />;
    case "headphones":
    case "cat-headphones":
      return <Headphones id={id} expression={expression} dark={art.rim} />;
    case "sunglasses":
      return <Sunglasses dark={art.rim} />;
    case "round-glasses":
      return <RoundGlasses dark={art.rim} />;
    case "beanie":
      return <Beanie />;
    case "cap":
      return <Cap />;
    case "crown":
      return <Crown />;
    case "bow":
      return <Bow />;
    case "flower":
      return <Flower />;
    case "scarf":
      return <Scarf />;
    case "space-helmet":
      return <SpaceHelmet expression={expression} />;
    case "none":
      return null;
  }
}

export function Accessory({ id, art, expression }: { id: MascotAccessory; art: KindArt; expression: MascotExpression }) {
  const piece = <Piece id={id} art={art} expression={expression} />;
  if (!art.hat || !(HATS.has(id) || HAIR.has(id))) return piece;
  const shrink = art.hatScale && HATS.has(id) ? ` translate(50 ${HAT_BRIM}) scale(${art.hatScale}) translate(-50 ${-HAT_BRIM})` : "";
  return <g transform={`translate(0 ${art.hat})${shrink}`}>{piece}</g>;
}
