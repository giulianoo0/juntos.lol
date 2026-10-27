// Every mascot kind in a grid for review: one expression and one accessory for all,
// the kind's colors as chips, and a strip at 48 px to judge them at tile size.
// Query: ?theme=light&expr=happy&acc=crown&still=1
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { KINDS, MASCOT_ACCESSORIES, MASCOT_EXPRESSIONS, MASCOT_KINDS, Mascot, serializeAvatar, type MascotAccessory, type MascotExpression, type MascotKind } from '../src/mascot'

const query = new URLSearchParams(location.search)
const voice = () => 0.5 + 0.5 * Math.sin(performance.now() / 140)

const css = `
:root { color-scheme: dark; --bg: #111; --fg: #e8e8ea; --muted: #8e8e93; --tile: #181819; --line: #262628; --on: #2a2a2d; --mascot-rim: #54555c }
:root[data-theme="light"] { color-scheme: light; --bg: #f6f6f7; --fg: #151515; --muted: #6e6e6e; --tile: #fff; --line: #e2e2e4; --on: #ececed; --mascot-rim: #b9b9bf }
* { box-sizing: border-box }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.4 ui-sans-serif, system-ui, sans-serif }
main { max-width: 1280px; margin: 0 auto; padding: 20px 16px 48px }
.bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; position: sticky; top: 0; z-index: 2; padding: 12px 0; background: var(--bg) }
.group { display: flex; flex-wrap: wrap; gap: 4px }
button { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; cursor: pointer }
button[aria-pressed="true"] { background: var(--on); border-color: var(--muted) }
.strip { display: flex; flex-wrap: wrap; gap: 10px; padding: 16px 0 20px; border-bottom: 1px solid var(--line); margin-bottom: 20px }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 12px }
.tile { background: var(--tile); border: 1px solid var(--line); border-radius: 16px; padding: 14px 10px 10px; display: flex; flex-direction: column; align-items: center; gap: 6px }
.tile svg { display: block }
.name { font-weight: 600 }
code { color: var(--muted); font: 11px ui-monospace, monospace }
.chips { display: flex; gap: 4px; min-height: 22px }
.chips button { padding: 1px 8px; font-size: 11px }
`

function Gallery() {
  const [theme, setTheme] = useState(query.get('theme') ?? 'dark')
  const [expression, setExpression] = useState<MascotExpression>((query.get('expr') as MascotExpression) ?? 'idle')
  const [accessory, setAccessory] = useState<MascotAccessory>((query.get('acc') as MascotAccessory) ?? 'none')
  const [still, setStill] = useState(query.has('still'))
  const [follow, setFollow] = useState(false)
  const [look, setLook] = useState<{ x: number; y: number } | null>(null)
  const [colors, setColors] = useState<Partial<Record<MascotKind, string>>>({})

  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => {
    if (!follow) return setLook(null)
    const move = (e: PointerEvent) => setLook({ x: (e.clientX / innerWidth) * 2 - 1, y: (e.clientY / innerHeight) * 2 - 1 })
    addEventListener('pointermove', move)
    return () => removeEventListener('pointermove', move)
  }, [follow])

  const level = expression === 'speaking' || expression === 'listening' ? voice : undefined
  const common = { expression, accessory, still, level, lookAt: look }

  return (
    <main>
      <style>{css}</style>
      <div className="bar">
        <div className="group">
          {MASCOT_EXPRESSIONS.map((e) => <button key={e} aria-pressed={e === expression} onClick={() => setExpression(e)}>{e}</button>)}
        </div>
        <div className="group">
          {MASCOT_ACCESSORIES.map((a) => <button key={a.id} aria-pressed={a.id === accessory} onClick={() => setAccessory(a.id)}>{a.label}</button>)}
        </div>
        <div className="group">
          <button aria-pressed={theme === 'light'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>Claro</button>
          <button aria-pressed={still} onClick={() => setStill(!still)}>Parado</button>
          <button aria-pressed={follow} onClick={() => setFollow(!follow)}>Seguir o mouse</button>
        </div>
      </div>
      <div className="strip">
        {MASCOT_KINDS.map((kind) => <Mascot key={kind} kind={kind} color={colors[kind]} size={48} title={KINDS[kind].name} {...common} />)}
      </div>
      <div className="grid">
        {MASCOT_KINDS.map((kind) => {
          const variants = Object.keys(KINDS[kind].colors ?? {})
          const color = colors[kind]
          const pick = (c?: string) => setColors((all) => ({ ...all, [kind]: c }))
          return (
            <div className="tile" key={kind} data-kind={kind}>
              <Mascot kind={kind} color={color} size={132} {...common} />
              <span className="name">{KINDS[kind].name}</span>
              <code>{serializeAvatar({ kind, color, accessory })}</code>
              <div className="chips">
                {variants.length ? (
                  <>
                    <button aria-pressed={!color} onClick={() => pick(undefined)}>padrão</button>
                    {variants.map((c) => <button key={c} aria-pressed={c === color} onClick={() => pick(c)}>{c}</button>)}
                  </>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Gallery />)
