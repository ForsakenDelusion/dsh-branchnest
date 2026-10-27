import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Position } from '../model.ts'

export function cardGesture(event: ReactPointerEvent, kind: 'move' | 'resize', original: Position, zoom: number,
  onFocus: () => void, onPosition: (p: Position) => void, onEnd: (p: Position) => void): void {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  event.preventDefault(); event.stopPropagation(); onFocus()
  const element = event.currentTarget as HTMLElement, x = event.clientX, y = event.clientY
  let latest = original; element.setPointerCapture(event.pointerId)
  const move = (e: PointerEvent) => {
    const dx = (e.clientX - x) / zoom, dy = (e.clientY - y) / zoom
    latest = kind === 'move' ? { ...original, x: Math.max(-1_000_000, Math.min(1_000_000, original.x + dx)), y: Math.max(-1_000_000, Math.min(1_000_000, original.y + dy)) }
      : { ...original, width: Math.max(300, Math.min(1200, original.width + dx)), height: Math.max(220, Math.min(1800, original.height + dy)) }
    onPosition(latest)
  }
  const end = () => { onEnd(latest); element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', end) }
  element.addEventListener('pointermove', move); element.addEventListener('pointerup', end, { once: true }); element.addEventListener('pointercancel', end, { once: true })
}
