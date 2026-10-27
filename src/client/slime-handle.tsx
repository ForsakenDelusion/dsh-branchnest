import { useEffect, useRef } from 'react'

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

// The two shoulders stay on the card edge. Only the hanging belly deforms.
function contour(x: number, y: number, ripple = 0, squash = 0): string {
  return `M 0 0 H 12 C 24 0 ${24 + x * .2} 6 ${24 + x * .3 + squash} 12`
    + ` L ${24 + x * .6 + squash} ${25 + y * .6 + ripple} Q ${24 + x + squash} ${39 + y + ripple} ${39 + x} ${39 + y + ripple}`
    + ` C ${80 + x} ${39 + y + ripple * .5} ${146 + x} ${39 + y - ripple * .5} ${185 + x} ${39 + y - ripple}`
    + ` Q ${200 + x - squash} ${39 + y - ripple} ${200 + x * .6 - squash} ${25 + y * .6 - ripple}`
    + ` L ${200 + x * .3 - squash} 12 C ${200 + x * .2} 6 200 0 212 0 H 224`
}
const resting = contour(0, 0)

export function SlimeHandle({ active, open, onClick }: { active: boolean; open: boolean; onClick(): void }) {
  const button = useRef<HTMLButtonElement>(null), fill = useRef<SVGPathElement>(null), rim = useRef<SVGPathElement>(null)
  const motion = useRef({ x: 0, y: 0, vx: 0, vy: 0 })

  useEffect(() => {
    const card = button.current?.closest<HTMLElement>('.pc-card')
    if (!card || !fill.current || !rim.current) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, previous = 0, pointer: { x: number; y: number; time: number } | undefined
    const paint = () => {
      const { x, y, vx, vy } = motion.current
      const path = contour(clamp(x, -4, 4), clamp(y, -2, 2), clamp(vx * .055, -1.8, 1.8), clamp(vy * .065, -1.1, 1.1))
      fill.current?.setAttribute('d', `${path} V -4 H 0 Z`)
      rim.current?.setAttribute('d', path)
    }
    const reset = () => { motion.current = { x: 0, y: 0, vx: 0, vy: 0 }; paint() }
    const tick = (time: number) => {
      frame = 0
      const dt = Math.min((time - (previous || time - 16.67)) / 1000, 1 / 30); previous = time
      const targetX = active && !open ? clamp(parseFloat(card.style.getPropertyValue('--pc-slime-x')) || 0, -2, 2) : 0
      const targetY = active && !open ? clamp(parseFloat(card.style.getPropertyValue('--pc-slime-y')) || 0, -.8, 1) : 0
      const m = motion.current
      // Momentum bends opposite corners; the attachment and label stay still.
      m.vx += ((targetX - m.x) * 220 - m.vx * 12) * dt
      m.vy += ((targetY - m.y) * 200 - m.vy * 11) * dt
      m.x += m.vx * dt; m.y += m.vy * dt
      paint()
      if (Math.abs(targetX - m.x) + Math.abs(targetY - m.y) + Math.abs(m.vx) + Math.abs(m.vy) > .025) frame = requestAnimationFrame(tick)
    }
    const wake = (event?: PointerEvent) => {
      if (reduced.matches || open) return
      if (event) {
        if (pointer && event.timeStamp - pointer.time < 120) {
          const proximity = parseFloat(card.style.getPropertyValue('--pc-slime-proximity')) || 0
          motion.current.vx = clamp(motion.current.vx + (event.clientX - pointer.x) * .65 * proximity, -40, 40)
          motion.current.vy = clamp(motion.current.vy + (event.clientY - pointer.y) * .5 * proximity, -25, 25)
        }
        pointer = { x: event.clientX, y: event.clientY, time: event.timeStamp }
      }
      if (!frame) { previous = 0; frame = requestAnimationFrame(tick) }
    }
    const preference = () => { cancelAnimationFrame(frame); frame = 0; reset(); if (!reduced.matches) wake() }
    // Listen only while this handle is revealed; idle cards never animate.
    if (active && !open) window.addEventListener('pointermove', wake, { passive: true })
    reduced.addEventListener('change', preference)
    if (reduced.matches || open) reset(); else wake()
    return () => { cancelAnimationFrame(frame); window.removeEventListener('pointermove', wake); reduced.removeEventListener('change', preference) }
  }, [active, open])

  return <button ref={button} type="button" className="pc-composer-handle" aria-expanded={open} aria-label="Ask or note"
    title={open ? '收起' : 'Ask or note'} onClick={event => { event.stopPropagation(); onClick() }}>
    <svg className="pc-slime-surface" viewBox="0 -4 224 50" aria-hidden="true">
      <path className="pc-slime-fill" d="M 0 -4 H 224 V 1.5 H 0 Z"/>
      <path ref={fill} className="pc-slime-fill" d={`${resting} V -4 H 0 Z`}/>
      <path ref={rim} className="pc-slime-rim" d={resting}/>
    </svg>
    <span className="pc-slime-label"><span>＋</span> Ask or note</span>
  </button>
}
