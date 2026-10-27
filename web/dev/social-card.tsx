// The link preview (public/social-card.png): the gang on the couch, seen from the TV.
// Rendered at 1200×630 and shot by social-card.mjs.
import { createRoot } from 'react-dom/client'
import { Mascot, type MascotAccessory, type MascotExpression, type MascotKind } from '../src/mascot'
import { HeroWordmark } from '../src/pages/home/Wordmark'

const BRAND = 'oklch(0.72 0.18 41)'

const css = `
:root { color-scheme: dark; --brand: ${BRAND}; --mascot-rim: #54555c }
* { box-sizing: border-box }
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #0c0a0b }
.card { position: relative; width: 1200px; height: 630px; overflow: hidden;
  background:
    radial-gradient(60% 80% at 74% 108%, oklch(0.72 0.18 41 / .45), transparent 70%),
    radial-gradient(50% 60% at 10% 0%, oklch(0.5 0.12 300 / .18), transparent 70%),
    #0c0a0b }
.wordmark { position: absolute; left: 70px; top: 150px; width: 470px; color: #fff }
.tagline { position: absolute; left: 72px; top: 310px; margin: 0; color: #f3efe9;
  font: 800 60px/1.02 'Bricolage Grotesque', sans-serif; letter-spacing: -.02em }
.tagline em { font-style: normal; color: var(--brand) }
.scene { position: absolute; left: 0; top: 0 }
.who { position: absolute }
.emoji { position: absolute; width: 64px; height: 64px; filter: drop-shadow(0 6px 14px rgb(0 0 0 / .45)) }
`

type Seat = { kind: MascotKind; x: number; y: number; size: number; expression: MascotExpression; accessory: MascotAccessory; color?: string; look?: { x: number; y: number }; tilt?: number }

// Back row peeks over the backrest, front row sits on the cushions.
const BACK: Seat[] = [
  { kind: 'ghost', x: 612, y: 170, size: 150, expression: 'happy', accessory: 'none', tilt: -10 },
  { kind: 'bunny', x: 800, y: 222, size: 150, expression: 'idle', accessory: 'flower', color: 'branco', look: { x: 0.4, y: 0.4 }, tilt: 4 },
  { kind: 'robot', x: 1050, y: 206, size: 150, expression: 'idle', accessory: 'headphones', look: { x: -0.5, y: 0.3 }, tilt: 8 },
]
const FRONT: Seat[] = [
  { kind: 'fox', x: 530, y: 316, size: 196, expression: 'happy', accessory: 'cap', tilt: -7 },
  { kind: 'axolotl', x: 688, y: 308, size: 196, expression: 'speaking', accessory: 'bow', look: { x: -0.7, y: 0.1 } },
  { kind: 'popcorn', x: 846, y: 300, size: 196, expression: 'happy', accessory: 'none', tilt: 3 },
  { kind: 'frog', x: 1004, y: 314, size: 196, expression: 'error', accessory: 'crown', tilt: 6 },
]

function Who({ s }: { s: Seat }) {
  return (
    <div className="who" style={{ left: s.x, top: s.y, transform: s.tilt ? `rotate(${s.tilt}deg)` : undefined }}>
      <Mascot kind={s.kind} color={s.color} size={s.size} expression={s.expression} accessory={s.accessory} lookAt={s.look ?? null} still />
    </div>
  )
}

function CouchBack() {
  return (
    <svg className="scene" width="1200" height="630" viewBox="0 0 1200 630">
      <rect x="500" y="336" width="760" height="200" rx="48" fill="#3a2131" />
      <path d="M 690 350 V 470 M 850 350 V 470 M 1010 350 V 470" stroke="#2c1825" strokeWidth="5" strokeLinecap="round" />
      <rect x="500" y="336" width="760" height="14" rx="7" fill="#4f2d41" />
    </svg>
  )
}
function CouchFront() {
  return (
    <svg className="scene" width="1200" height="630" viewBox="0 0 1200 630">
      <rect x="480" y="476" width="780" height="110" rx="34" fill="#55293e" />
      <rect x="480" y="476" width="780" height="14" rx="7" fill="#6e3753" />
      <path d="M 760 494 V 568 M 1040 494 V 568" stroke="#45202f" strokeWidth="5" strokeLinecap="round" />
      <rect x="448" y="408" width="104" height="190" rx="46" fill="#63304b" />
      <rect x="448" y="408" width="104" height="22" rx="11" fill="#7a3d5d" />
      <rect x="520" y="584" width="18" height="34" rx="6" fill="#241319" />
      <rect x="1170" y="584" width="18" height="34" rx="6" fill="#241319" />
    </svg>
  )
}

function Card() {
  return (
    <div className="card" id="card">
      <style>{css}</style>
      <HeroWordmark className="wordmark" />
      <p className="tagline">assiste junto<br />com a <em>galera</em></p>
      {BACK.map((s) => <Who key={s.kind} s={s} />)}
      <CouchBack />
      {FRONT.map((s) => <Who key={s.kind} s={s} />)}
      <CouchFront />
      <img className="emoji" src="/emoji/1f602.png" style={{ left: 600, top: 110, transform: 'rotate(-12deg)' }} />
      <img className="emoji" src="/emoji/2764-fe0f.png" style={{ left: 960, top: 92, transform: 'rotate(10deg)' }} />
      <img className="emoji" src="/emoji/1f525.png" style={{ left: 1100, top: 60, width: 48, height: 48, transform: 'rotate(14deg)' }} />
      <img className="emoji" src="/emoji/1f62e.png" style={{ left: 770, top: 58, width: 48, height: 48, transform: 'rotate(-6deg)' }} />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Card />)
