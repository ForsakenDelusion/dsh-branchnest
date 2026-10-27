import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { LiveTranscript, projectSessionMessages } from '../src/transcript.ts'
import { digest } from '../src/canvas.ts'

const assistant = (content: unknown[], seq = 2) => ({ type: 'assistant/message', seq,
  data: { turn: 1, step: 1, message: { role: 'assistant', content } } }) as unknown as SessionEvent
const frame = (value: object) => value as AssistantStreamFrame

test('uploaded files survive the native transcript, including attachment-only prompts', () => {
  const event = { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [
    { type: 'file', attachment: { name: 'paper.pdf', attachmentId: 'sha256:fixture' } }] } } as unknown as SessionEvent
  const [message] = projectSessionMessages([event], () => '', () => '/private/attachments/paper.pdf')
  assert.equal(message.text, '')
  assert.deepEqual(message.files, [{ name: 'paper.pdf', path: '/private/attachments/paper.pdf' }])
  assert.equal(message.hash, digest(''))
  const [unavailable] = projectSessionMessages([event], () => '')
  assert.equal(unavailable.files?.[0].name, 'paper.pdf', 'missing file bytes do not erase the visible attachment')
})

test('native reasoning and tool calls remain separate from the visible answer, retaining old source hashes', () => {
  const event = assistant([{ type: 'reasoning', text: '先核对证据，再回答。' },
    { type: 'tool-call', id: 'check', name: 'bash', arguments: '{"command":"pwd"}' }, { type: 'text', text: '这是回答正文。' }])
  const legacy = 'bash\n{"command":"pwd"}\n这是回答正文。'
  const [message] = projectSessionMessages([event], () => legacy)
  assert.equal(message.reasoning, '先核对证据，再回答。')
  assert.equal(message.text, '这是回答正文。')
  assert.deepEqual(message.tools, [{ id: 'check', name: 'bash', arguments: '{"command":"pwd"}' }])
  assert.equal(message.hash, digest(legacy), 'existing branch anchors keep their native-search hash')
})

test('a reasoning-only native step is not discarded before an answer exists', () => {
  const messages = projectSessionMessages([assistant([{ type: 'reasoning', text: '还在检查来源。' }])], () => '')
  assert.equal(messages.length, 1)
  assert.equal(messages[0].reasoning, '还在检查来源。')
  assert.equal(messages[0].text, '')
})

test('live reasoning deltas reach the transcript and stop streaming once answer text starts', () => {
  const live = new LiveTranscript()
  live.accept('a', frame({ type: 'start', attemptId: 'attempt-a' }))
  live.accept('a', frame({ type: 'chunk', attemptId: 'attempt-a', chunk: { type: 'reasoning-delta', index: 0, text: '检查' } }))
  live.accept('a', frame({ type: 'chunk', attemptId: 'attempt-a', chunk: { type: 'reasoning-delta', index: 0, text: '证据。' } }))
  assert.equal(live.get('a')?.reasoning, '检查证据。')
  assert.equal(live.get('a')?.reasoningLive, true)
  assert.equal(live.get('b'), undefined)
  live.accept('a', frame({ type: 'chunk', attemptId: 'attempt-a', chunk: { type: 'text-delta', index: 1, text: '回答' } }))
  assert.equal(live.get('a')?.reasoningLive, false)
  assert.equal(live.get('a')?.text, '回答')
  live.accept('a', frame({ type: 'end', attemptId: 'attempt-a' }))
  assert.equal(live.get('a'), undefined)
})

test('stream block settlement does not duplicate deltas and stale attempts cannot erase a new reply', () => {
  const live = new LiveTranscript()
  live.accept('a', frame({ type: 'start', attemptId: 'old' }))
  live.accept('a', frame({ type: 'start', attemptId: 'new' }))
  live.accept('a', frame({ type: 'chunk', attemptId: 'old', chunk: { type: 'reasoning-delta', index: 0, text: '旧内容' } }))
  live.accept('a', frame({ type: 'chunk', attemptId: 'new', chunk: { type: 'reasoning-delta', index: 0, text: '新内容' } }))
  live.accept('a', frame({ type: 'chunk', attemptId: 'new', chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: '新内容' } } }))
  assert.equal(live.get('a')?.reasoning, '新内容'); assert.equal(live.get('a')?.reasoningLive, false)
  live.accept('a', frame({ type: 'end', attemptId: 'old' }))
  assert.equal(live.get('a')?.reasoning, '新内容')
  live.delete('a'); assert.equal(live.get('a'), undefined)
})

test('tool-only assistant steps stay visible as process content without inventing an answer', () => {
  const [message] = projectSessionMessages([assistant([{ type: 'tool-call', id: 'tool-a', name: 'bash', arguments: '{}' }])], () => 'bash\n{}')
  assert.equal(message.text, '')
  assert.equal(message.reasoning, undefined)
  assert.equal(message.tools?.[0].name, 'bash')
})
