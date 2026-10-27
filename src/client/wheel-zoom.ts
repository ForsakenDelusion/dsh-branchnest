import type { Viewport } from '../model.ts'

export const limitZoom = (zoom: number) => Math.max(.2, Math.min(2, zoom))
const MAX_PENDING = .18, SENSITIVITY = .0015
interface WheelDelta { deltaMode: number; deltaY: number }

/** Unit conversion precedes integration: smooth fractional events retain their precision. */
export function wheelDistance(event: WheelDelta, pageHeight: number): number {
  const mode = event.deltaMode, delta = event.deltaY
  return Number.isFinite(delta) ? delta * (mode === 1 ? 16 : mode === 2 ? pageHeight : 1) : 0
}

/** Bounded log-scale motion, shared by wheel notches, trackpads and MOS event streams. */
export class WheelZoom {
  private pending = 0
  private point = { x: 0, y: 0 }
  push(event: WheelDelta, point: { x: number; y: number }, pageHeight: number): boolean {
    const delta = -wheelDistance(event, pageHeight) * SENSITIVITY
    if (!delta) return false
    // A direction change responds immediately instead of spending the previous tail first.
    if (Math.sign(delta) !== Math.sign(this.pending)) this.pending = 0
    this.pending = Math.max(-MAX_PENDING, Math.min(MAX_PENDING, this.pending + delta))
    this.point = point
    return true
  }
  step(viewport: Viewport, elapsed: number, instant = false): Viewport | undefined {
    if (!this.pending) return
    const dt = Math.max(0, Math.min(64, elapsed))
    let amount = instant ? this.pending : this.pending * (1 - Math.exp(-dt / 45))
    if (!instant) amount = Math.max(-dt * .002, Math.min(dt * .002, amount))
    if (Math.abs(this.pending) < .0001) amount = this.pending
    const zoom = limitZoom(viewport.zoom * Math.exp(amount)), scale = zoom / viewport.zoom
    this.pending -= amount
    if (zoom === .2 || zoom === 2 || Math.abs(this.pending) < 1e-8) this.pending = 0
    return { x: this.point.x - (this.point.x - viewport.x) * scale,
      y: this.point.y - (this.point.y - viewport.y) * scale, zoom }
  }
  reset(): void { this.pending = 0 }
}
