import { useState } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Message, MessageTool } from '../model.ts'
import { MessageFiles, UserMessageText } from './file-links.tsx'

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '参考注释' }

/** Shared presentation for cards, the reader and floating chat. Only answer text is a branch source. */
export function MessageBody({ message, sessionId, onSelect }: { message: Message; sessionId: string; onSelect?(element: HTMLElement): void }) {
  const [thinkingOpen, setThinkingOpen] = useState(false)
  return <>
    {!!message.files?.length && <MessageFiles files={message.files} sessionId={sessionId}/>}
    {message.reasoning && <div className="pc-process pc-thinking" data-state={message.reasoningLive ? 'running' : 'done'}>
      <button className="pc-process-toggle" type="button" aria-expanded={thinkingOpen} onClick={() => setThinkingOpen(value => !value)}>
        <svg className="pc-process-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5"/></svg>
        <span>{message.reasoningLive ? '思考中…' : '思考过程'}</span>
        {message.reasoningLive && <i className="pc-thinking-dot" aria-hidden="true"/>}
      </button>
      {thinkingOpen && <div className="pc-process-body pc-markdown"><MarkdownText text={message.reasoning} streaming={message.reasoningLive} labels={labels}/></div>}
    </div>}
    {message.tools?.map(tool => <ToolDisclosure key={tool.id} tool={tool}/>)}
    {message.text && <div className="pc-markdown" onMouseUp={event => onSelect?.(event.currentTarget)}>
      {message.role === 'user' ? <UserMessageText text={message.text} sessionId={sessionId}/>
        : <MarkdownText text={message.text} streaming={message.live} labels={labels}/>}
    </div>}
  </>
}

function ToolDisclosure({ tool }: { tool: MessageTool }) {
  const [open, setOpen] = useState(false)
  let details = tool.arguments, description = ''
  try { const args: unknown = JSON.parse(tool.arguments); details = JSON.stringify(args, null, 2)
    if (args && typeof args === 'object' && 'description' in args && typeof args.description === 'string') description = args.description
  } catch { /* Partial arguments remain readable during streaming. */ }
  return <div className="pc-process pc-tool">
    <button className="pc-process-toggle" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <svg className="pc-process-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5"/></svg>
      <span>工具调用 · {tool.name}</span>{description && <small title={description}>{description}</small>}
    </button>
    {open && <pre className="pc-tool-arguments"><code>{details}</code></pre>}
  </div>
}
