import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userTextParts, sessionFileResource } from '../src/client/file-references.ts'
import { WheelZoom, wheelDistance } from '../src/client/wheel-zoom.ts'

test('dragged quoted POSIX and Windows files become compact references without changing prose', () => {
  assert.deepEqual(userTextParts('@"/tmp/cache/GPT paper #1.pdf" 请读一下。'), [
    { kind: 'file', path: '/tmp/cache/GPT paper #1.pdf', name: 'GPT paper #1.pdf' }, { kind: 'text', text: ' 请读一下。' }])
  assert.deepEqual(userTextParts('@"C:\\Users\\me\\论文.pdf"'), [{ kind: 'file', path: 'C:\\Users\\me\\论文.pdf', name: '论文.pdf' }])
  assert.equal(userTextParts('看 @docs/intro.md 和 @README.md').filter(p => p.kind === 'file').length, 2)
})

test('reference parsing leaves emails, skills, URLs, code examples and unfinished mentions alone', () => {
  for (const text of ['a@b.com @skill', '@https://example.com/a.pdf', '@"/unfinished path', '`@docs/a.md`', '```sh\n@docs/a.md\n```', '@"javascript:alert(1).pdf"'])
    assert.deepEqual(userTextParts(text), [{ kind: 'text', text }])
})

test('file preview addresses retain exact names and session scope across platforms', () => {
  assert.equal(sessionFileResource('session-a', '/tmp/a #1?.pdf'), 'dsh-resource://file/session/session-a//tmp/a%20%231%3F.pdf')
  assert.equal(sessionFileResource('session-b', 'C:\\docs\\a.pdf'), 'dsh-resource://file/session/session-b/C:/docs/a.pdf')
})

const start = { x: 40, y: 30, zoom: .85 }, point = { x: 320, y: 240 }
function settle(deltas: Array<{ deltaMode: number; deltaY: number }>) {
  const motion = new WheelZoom(); for (const event of deltas) motion.push(event, point, 800)
  let viewport = start
  for (let i = 0; i < 80; i++) viewport = motion.step(viewport, 16) ?? viewport
  return viewport
}
test('pixel, line and page wheels use matching units; fragmented MOS deltas have the same final scale', () => {
  assert.equal(wheelDistance({deltaMode:1,deltaY:3},800),48)
  const pixel = settle([{deltaMode:0,deltaY:48}])
  for (const events of [[{deltaMode:1,deltaY:3}], [{deltaMode:2,deltaY:.06}], Array.from({length:48},()=>({deltaMode:0,deltaY:1}))])
    assert.ok(Math.abs(settle(events).zoom - pixel.zoom)<1e-10)
  assert.ok(settle([{deltaMode:0,deltaY:.125}]).zoom < start.zoom, 'subpixel input is not rounded away')
  const smooth = new WheelZoom(); let viewport = start
  for (let i = 0; i < 48; i++) { smooth.push({deltaMode:0,deltaY:1},point,800); viewport = smooth.step(viewport,8) ?? viewport }
  for (let i = 0; i < 80; i++) viewport = smooth.step(viewport,16) ?? viewport
  assert.ok(Math.abs(viewport.zoom - pixel.zoom)<1e-10, 'events spread over animation frames preserve the same gesture distance')
})

test('outlier deltas are bounded, the pointer stays anchored and every frame has a speed limit', () => {
  const motion = new WheelZoom(); motion.push({deltaMode:0,deltaY:-10000},point,800)
  const first = motion.step(start,16)!
  assert.ok(first.zoom/start.zoom <= Math.exp(.032)+1e-10)
  const end = settle([{deltaMode:0,deltaY:-10000}])
  assert.ok(end.zoom/start.zoom <= Math.exp(.18)+1e-10)
  assert.ok(Math.abs((point.x-start.x)/start.zoom-(point.x-end.x)/end.zoom)<1e-10)
  assert.ok(Math.abs((point.y-start.y)/start.zoom-(point.y-end.y)/end.zoom)<1e-10)
})

test('reversing, resetting and hitting the scale limit discard stale motion', () => {
  const motion = new WheelZoom();motion.push({deltaMode:0,deltaY:-100},point,800)
  const first=motion.step(start,16)!
  motion.push({deltaMode:0,deltaY:10},point,800)
  assert.ok(motion.step(first,16)!.zoom<first.zoom)
  motion.reset();assert.equal(motion.step(first,16),undefined)
  motion.push({deltaMode:0,deltaY:-100},point,800)
  assert.equal(motion.step({...start,zoom:2},16)!.zoom,2)
  assert.equal(motion.step(start,16),undefined)
})
