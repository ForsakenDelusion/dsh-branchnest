import { useEffect, useRef, useState } from 'react'
import { cardGesture } from './card-gesture.ts'
import { MessageBody } from './message-body.tsx'
import { focusCardBody, selectCardBody } from './card-selection.ts'
import type { ContextPlan, Edge, Message, Position, SessionCard } from '../model.ts'
import type { CanvasApi, Composer, Selection, Transcript } from './api.ts'
import { CardComposer } from './ask-dock.tsx'
import type { ComposerAction } from './ask-dock.tsx'
import { ArchiveIcon } from './archive-dialog.tsx'
import { SourceAction } from './source-action.tsx'
import { PresetPill } from './preset-pill.tsx'
import type { BranchPreset } from '../presets.ts'

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

export function SessionNode({ api, workspaceId, node, edge, zoom, focused, near, readable, highlightedSeq, composer,
  onFocus, onPosition, onPositionEnd, onSelect, onReveal, onCompose, onCloseCompose, onSubmitCompose, onOpenSession, onArchive, loadPreview, linkTarget, fresh, onLinkDrag }: {
  api: CanvasApi; workspaceId: string; node: SessionCard; edge?: Edge; zoom: number; focused: boolean; near: boolean; readable: boolean; highlightedSeq?: number;
  composer?: Composer;
  onFocus(): void; onPosition(p: Position): void; onPositionEnd(p: Position): void;
  onSelect(value: Selection): void; onReveal(id: string, seq?: number): void;
  onCompose(anchor?: import('../model.ts').Anchor): void; onCloseCompose(): void;
  onSubmitCompose(action: ComposerAction, text: string, operationId: string, exclude: string[], preset?: BranchPreset, anchor?: import('../model.ts').Anchor): Promise<void>;
  onOpenSession(): void; onArchive(): void; loadPreview?(exclude: string[]): Promise<ContextPlan>
  linkTarget?: boolean; fresh?: boolean; onLinkDrag?(event: import('react').PointerEvent): void
}) {
  const [data, setData] = useState<Transcript>({ messages: [], hasMore: false, running: node.running, error: null })
  const [loaded, setLoaded] = useState(false), [error, setError] = useState('')
  const older = useRef<Message[]>([]), scroll = useRef<HTMLDivElement>(null), nearBottom = useRef(true)
  const hasEarlier = useRef<boolean | null>(null), seen = useRef(new Map<number, Message>())
  const jump = useRef<number | null>(null)
  useEffect(() => {
    if (!readable || node.position.collapsed) return
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined
    const update = async () => {
      try { const result = await api.messages(workspaceId, node.sessionId, abort.signal)
        if (abort.signal.aborted) return
        for (const [seq, message] of seen.current) if (message.live) seen.current.delete(seq)
        for (const message of result.messages) seen.current.set(message.seq, message)
        setData({ ...result, messages: [...seen.current.values()], hasMore: hasEarlier.current ?? result.hasMore }); setLoaded(true); setError('')
        timer = setTimeout(() => void update(), result.running ? 700 : 3000)
      } catch (e) { if (!abort.signal.aborted) { setError(errorText(e)); timer = setTimeout(() => void update(), 4000) } }
    }
    void update(); return () => { abort.abort(); if (timer) clearTimeout(timer) }
  }, [api, workspaceId, node.sessionId, readable, node.position.collapsed])
  useEffect(() => { if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [data.messages])
  useEffect(() => {
    if (highlightedSeq === undefined || !readable || node.position.collapsed) return
    const abort = new AbortController(); nearBottom.current = false
    void api.messages(workspaceId, node.sessionId, abort.signal, highlightedSeq + 1).then(page => {
      if (abort.signal.aborted) return
      for (const message of page.messages) seen.current.set(message.seq, message)
      jump.current = highlightedSeq
      setData(d => ({ ...d, messages: [...seen.current.values()] }))
    }).catch(e => { if (!abort.signal.aborted) setError(errorText(e)) })
    return () => abort.abort()
  }, [api, workspaceId, node.sessionId, highlightedSeq, readable, node.position.collapsed])
  useEffect(() => {
    if (jump.current === null) return
    const element = scroll.current?.querySelector<HTMLElement>(`[data-seq="${jump.current}"]`)
    if (element && scroll.current) { scroll.current.scrollTo({ top: element.offsetTop - 12, behavior: 'smooth' }); jump.current = null }
  }, [data.messages])

  const gesture = (event: import('react').PointerEvent, kind: 'move' | 'resize') => cardGesture(event, kind, node.position, zoom, onFocus, onPosition, onPositionEnd)
  const select = (message: Message, element: HTMLElement) => {
    if (message.live) return
    const selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const range = selection.getRangeAt(0)
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return
    const quote = selection.toString().trim(); if (!quote || quote.length > 6000) return
    const bounds = range.getBoundingClientRect()
    onSelect({ anchor: { sessionId: node.sessionId, seq: message.seq, quote, messageHash: message.hash }, title: node.title,
      x: bounds.left, y: bounds.bottom + 8, range: range.cloneRange() })
  }
  const loadOlder = async () => {
    const first = older.current[0] ?? data.messages[0]; if (!first) return
    try { const result = await api.messages(workspaceId, node.sessionId, undefined, first.seq)
      older.current = [...result.messages, ...older.current]; hasEarlier.current = result.hasMore
      setData(d => ({ ...d, hasMore: result.hasMore })); nearBottom.current = false
    } catch (e) { setError(errorText(e)) }
  }
  const unique = new Map([...older.current, ...data.messages].map(m => [m.seq, m]))
  const messages = [...unique.values()].sort((a, b) => a.seq - b.seq)
  const p = node.position, running = data.running || node.running
  return <article className={`pc-card${focused ? ' pc-focused' : ''}${near ? ' pc-near' : ''}${composer ? ' pc-ask-open' : ''}${linkTarget ? ' pc-link-target' : ''}${fresh ? ' pc-card-fresh' : ''}`} data-session-id={node.sessionId}
    style={{ left: p.x, top: p.y, width: p.width, height: p.collapsed ? 48 : p.height }} onPointerDown={onFocus}
    onKeyDownCapture={event => selectCardBody(event, scroll.current)}>
    <div className="pc-card-surface">
    <header className="pc-card-header" onPointerDown={e => gesture(e, 'move')}>
      {running && <span className="pc-status pc-status-running" title="正在生成"/>}<strong title={node.title}>{node.title}</strong>
      <PresetPill preset={node.preset}/>
      {running && <button title="停止生成" aria-label="停止生成" onClick={() => void api.cancel(workspaceId, node.sessionId).catch(e => setError(errorText(e)))}>■</button>}
      {edge && <SourceAction title={edge.sourceTitle ?? '来源对话'} quote={edge.anchor.quote}
        onClick={() => onReveal(edge.noteId ?? edge.anchor.sessionId, edge.noteId ? undefined : edge.anchor.seq)}/>}
      <button title={p.collapsed ? '展开对话' : '收起对话'} aria-label={p.collapsed ? '展开对话' : '收起对话'} onClick={() => onPositionEnd({ ...p, collapsed: !p.collapsed })}>{p.collapsed ? '＋' : '−'}</button>
      {onLinkDrag && <button className="pc-link-handle" title="拖到另一张卡片，把它的内容加入本卡上下文" aria-label="拖拽添加上下文" onPointerDown={onLinkDrag}>⇢</button>}
      <button title="展开阅读" aria-label="展开阅读" onClick={onOpenSession}>⛶</button>
      <button className="pc-archive-action" title="归档对话" aria-label="归档对话" onClick={onArchive}><ArchiveIcon/></button>
    </header>
    {!p.collapsed && <>
      <div className="pc-scroll" ref={scroll} tabIndex={0} data-pc-select-scope="" aria-label="卡片正文" onPointerDown={focusCardBody}
        onScroll={e => { const n = e.currentTarget; nearBottom.current = n.scrollHeight - n.scrollTop - n.clientHeight < 90 }}>
        {!readable ? <button className="pc-load" onClick={() => onReveal(node.sessionId)}>聚焦这张卡片，开始阅读</button>
          : !loaded ? <p className="pc-muted">正在读取对话…</p>
          : <>{data.hasMore && <button className="pc-load" onClick={() => void loadOlder()}>加载更早的对话</button>}
            {!messages.length && <p className="pc-muted">还没有消息</p>}
            {messages.map(message => <div key={message.seq} className={`pc-message pc-message-${message.role}${highlightedSeq === message.seq ? ' pc-highlight' : ''}`} data-seq={message.seq}>
              {(message.role === 'user' || (message.live && !!message.text)) && <small>{message.role === 'user' ? '你' : '正在回答…'}</small>}
              <MessageBody message={message} sessionId={node.sessionId} onSelect={element => { if (message.role === 'assistant') select(message, element) }}/>
            </div>)}</>}
        {(error || data.error) && <div className="pc-error" role="alert">{error || data.error}</div>}
      </div>
      <div className="pc-resize" title="调整卡片大小" onPointerDown={e => gesture(e, 'resize')} />
    </>}
    </div>
    {!p.collapsed && <CardComposer open={!!composer} near={near} anchor={composer?.anchor} loadPreview={loadPreview}
      onOpen={() => {
        const answer = messages.findLast(m => m.role === 'assistant' && !m.live && m.text.trim())
        onCompose(answer ? { sessionId: node.sessionId, seq: answer.seq, quote: answer.text.slice(0, 6000), messageHash: answer.hash } : undefined)
      }}
      onClose={onCloseCompose} onSubmit={onSubmitCompose} />}
  </article>
}
