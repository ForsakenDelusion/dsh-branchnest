import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Message, MessageTool } from './model.ts'
import { digest } from './canvas.ts'

/** Project native history into the same bounded transcript used by every canvas view. */
export function projectSessionMessages(events: readonly SessionEvent[], nativeText: (event: SessionEvent) => string,
  filePath?: (attachment: Extract<ContentBlock, { type: 'file' }>['attachment']) => string | undefined): Message[] {
  const messages: Message[] = []
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    if (event.type === 'user/message' && event.data.source.kind !== 'user') continue
    const legacyText = nativeText(event)
    const files = event.type === 'user/message' ? event.data.content.flatMap(block => block.type === 'file'
      ? [{ name: block.attachment.name, path: filePath?.(block.attachment) }] : []) : []
    const content = event.type === 'assistant/message' ? projectContent(event.data.message.content)
      : { text: legacyText, ...(files.length ? { files } : {}) }
    if (hasContent(content)) messages.push({ ...content, seq: event.seq,
      role: event.type === 'user/message' ? 'user' : 'assistant',
      // Preserve the previous hash currency used by durable branch/selection anchors.
      hash: digest(legacyText) })
  }
  return messages
}

/** One transient assistant attempt per session; settlement is supplied by native history. */
export class LiveTranscript {
  private messages = new Map<string, { attemptId: string; blocks: Map<number, ContentBlock>; reasoningLive: boolean }>()
  accept(id: string, frame: AssistantStreamFrame): void {
    if (frame.type === 'start') { this.messages.set(id, { attemptId: frame.attemptId, blocks: new Map(), reasoningLive: false }); return }
    const state = this.messages.get(id)
    if (!state || state.attemptId !== frame.attemptId) return
    if (frame.type === 'end') { this.messages.delete(id); return }
    const chunk = frame.chunk
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning', previous = state.blocks.get(chunk.index)
      const prefix = previous?.type === type ? previous.text : ''
      state.blocks.set(chunk.index, { type, text: prefix + chunk.text })
      state.reasoningLive = type === 'reasoning'
    } else if (chunk.type === 'tool-call-delta') {
      const previous = state.blocks.get(chunk.index), tool = previous?.type === 'tool-call' ? previous : undefined
      state.blocks.set(chunk.index, { type: 'tool-call', id: chunk.id, name: chunk.name ?? tool?.name ?? '',
        arguments: (tool?.arguments ?? '') + chunk.argumentsDelta })
      state.reasoningLive = false
    } else if (chunk.type === 'block-end') {
      state.blocks.set(chunk.index, chunk.block)
      if (chunk.block.type === 'reasoning') state.reasoningLive = false
    }
  }
  get(id: string): Message | undefined {
    const state = this.messages.get(id)
    if (!state) return
    const content = projectContent([...state.blocks].sort(([a], [b]) => a - b).map(([, block]) => block))
    return hasContent(content) ? { ...content, seq: Number.MAX_SAFE_INTEGER, role: 'assistant', hash: '', live: true,
      reasoningLive: state.reasoningLive } : undefined
  }
  delete(id: string): void { this.messages.delete(id) }
}

function projectContent(blocks: readonly ContentBlock[]): Pick<Message, 'text' | 'reasoning' | 'tools'> {
  const text: string[] = [], reasoning: string[] = [], tools: MessageTool[] = []
  for (const block of blocks) {
    if (block.type === 'text') text.push(block.text)
    else if (block.type === 'reasoning') reasoning.push(block.text)
    else if (block.type === 'tool-call') tools.push({ id: block.id, name: block.name, arguments: block.arguments })
  }
  return { text: text.map(value => value.trim()).filter(Boolean).join('\n'),
    ...(reasoning.length ? { reasoning: reasoning.join('\n\n') } : {}), ...(tools.length ? { tools } : {}) }
}
const hasContent = (content: Pick<Message, 'text' | 'reasoning' | 'tools' | 'files'>) => !!(content.text || content.reasoning || content.tools?.length || content.files?.length)
