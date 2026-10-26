import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Keeps a stage's element alive while the room's layout moves it between the
 * grid, the focus and the side column. The player, the live and the screens
 * render once, through a portal, into a node of their own; a slot only lends
 * that node a place in the layout. Moving a playing `<video>` from one parent
 * to another in the same task does not pause it, so pinning never reloads
 * the media.
 */
export function useStageHosts() {
  const nodes = useRef(new Map<string, HTMLDivElement>())

  const nodeFor = useCallback((id: string) => {
    let node = nodes.current.get(id)
    if (!node) {
      node = document.createElement('div')
      node.className = 'stage-host'
      node.dataset.stage = id
      nodes.current.set(id, node)
    }
    return node
  }, [])

  /** The stage's content, rendered once wherever the slot currently is. */
  const portal = useCallback((id: string, children: ReactNode) => createPortal(children, nodeFor(id), id), [nodeFor])

  /** A place in the layout for the stage `id`. */
  const slot = useCallback((id: string) => <StageSlot key={id} node={nodeFor(id)} />, [nodeFor])

  return { portal, slot }
}

function StageSlot({ node }: { node: HTMLDivElement }) {
  const place = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const parent = place.current
    if (!parent) return
    parent.appendChild(node)
    return () => {
      if (node.parentNode === parent) parent.removeChild(node)
    }
  }, [node])
  return <div ref={place} className="stage-slot" />
}
