import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { MessageBody } from './message-body.tsx'
import { focusCardBody, selectCardBody } from './card-selection.ts'
import type { Anchor, ContextPlan, Message, Snapshot } from '../model.ts'
import type { BranchPreset } from '../presets.ts'
import type { CanvasApi, Transcript } from './api.ts'
import { CardComposer } from './ask-dock.tsx'
import type { ComposerAction } from './ask-dock.tsx'
import { PresetPill } from './preset-pill.tsx'

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const stayOpen = () => {}

/** A reading surface over native history. Branching continues to use independent sessions. */
export function SessionReader({ api, workspaceId, snapshot, sessionId, drafts, onOpen, onClose, onOpenNative, onSubmit }: {
  api: CanvasApi; workspaceId: string; snapshot: Snapshot; sessionId: string; drafts: Map<string, string>;
  onOpen(id: string): void; onClose(): void; onOpenNative(id: string): void;
  onSubmit(action: ComposerAction, text: string, operationId: string, exclude: string[], preset?: BranchPreset, anchor?: Anchor): Promise<void>
}) {
  const node = snapshot.nodes.find(item => item.sessionId === sessionId)
  const [data, setData] = useState<Transcript & { sessionId: string }>({ sessionId: '', messages: [], hasMore: false, running: false, error: null })
  const [error, setError] = useState(''), [loadingOlder, setLoadingOlder] = useState(false)
  const [fontSize, setFontSize] = useState(17), [selected, setSelected] = useState<{ anchor: Anchor; range: Range } | null>(null)
  const [branchesOpen, setBranchesOpen] = useState(true)
  const branchesId = useId(), branchesRoot = useRef<HTMLElement>(null)
  const root = useRef<HTMLElement>(null), scroll = useRef<HTMLDivElement>(null)
  const records = useRef({ id: '', messages: new Map<number, Message>(), hasMore: true })
  const nearBottom = useRef(false), firstRead = useRef(true), olderScroll = useRef<number | null>(null)
  const scrollPositions = useRef(new Map<string, number>())
  const currentId = useRef(sessionId); currentId.current = sessionId
  const requestLife = useRef<AbortController | null>(null)
  const readyForOlder = useRef(false)
  const branchIds = new Set(snapshot.links.filter(link => link.fromId === sessionId).map(link => link.toId))
  const branches = snapshot.nodes.filter(item => branchIds.has(item.sessionId))
  const parentId = snapshot.links.find(link => link.toId === sessionId)?.fromId
  const parentTitle = snapshot.nodes.find(item => item.sessionId === parentId)?.title
    ?? (snapshot.notes.some(item => item.id === parentId) ? 'Note' : undefined)
  const ready = data.sessionId === sessionId
  const messages = ready ? data.messages : []
  const lastAnswer = messages.findLast(message => message.role === 'assistant' && !message.live && message.text.trim())
  const anchor = selected?.anchor ?? (lastAnswer ? { sessionId, seq: lastAnswer.seq, quote: lastAnswer.text.slice(0, 6000), messageHash: lastAnswer.hash } : undefined)

  useLayoutEffect(() => {
    if (branchesRoot.current) branchesRoot.current.inert = !branchesOpen
  }, [branchesOpen])

  useEffect(() => {
    const element = root.current; if (!element?.parentElement) return
    const previousFocus = document.activeElement
    const siblings = Array.from(element.parentElement.children).filter((item): item is HTMLElement => item instanceof HTMLElement && item !== element)
    const previous = siblings.map(item => item.inert)
    siblings.forEach(item => { item.inert = true })
    return () => {
      siblings.forEach((item, index) => { item.inert = previous[index]! })
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => { if (!node) onClose() }, [!!node, onClose])
  useEffect(() => {
    const abort = new AbortController(); requestLife.current = abort
    let timer: ReturnType<typeof setTimeout> | undefined
    const current = { id: sessionId, messages: new Map<number, Message>(), hasMore: true }; records.current = current
    firstRead.current = true; olderScroll.current = null; nearBottom.current = false
    setError(''); setSelected(null); setLoadingOlder(false)
    scroll.current?.focus({ preventScroll: true })
    const update = async () => {
      try {
        const result = await api.messages(workspaceId, sessionId, abort.signal)
        if (abort.signal.aborted) return
        for (const [seq, message] of current.messages) if (message.live) current.messages.delete(seq)
        for (const message of result.messages) current.messages.set(message.seq, message)
        const transcript = [...current.messages.values()].sort((a, b) => a.seq - b.seq)
        if (!readyForOlder.current) current.hasMore = result.hasMore
        setData({ ...result, sessionId, hasMore: current.hasMore, messages: transcript }); setError('')
        timer = setTimeout(() => void update(), result.running ? 700 : 3000)
      } catch (error) {
        if (!abort.signal.aborted) { setError(errorText(error)); timer = setTimeout(() => void update(), 4000) }
      }
    }
    readyForOlder.current = false
    void update()
    return () => { abort.abort(); if (timer) clearTimeout(timer) }
  }, [api, workspaceId, sessionId])
  useLayoutEffect(() => {
    const element = scroll.current
    if (!element || !ready) return
    if (firstRead.current) {
      element.scrollTop = scrollPositions.current.get(sessionId) ?? 0; firstRead.current = false
      nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90
    } else if (olderScroll.current !== null) {
      element.scrollTop += element.scrollHeight - olderScroll.current; olderScroll.current = null
    } else if (nearBottom.current) element.scrollTop = element.scrollHeight
  }, [data.messages, ready, sessionId])
  useEffect(() => {
    if (!selected) return
    try {
      const registry = (CSS as unknown as { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } }).highlights
      const HighlightType = (globalThis as unknown as { Highlight?: new (range: Range) => unknown }).Highlight
      if (!registry || !HighlightType) return
      registry.set('pc-reader-quote', new HighlightType(selected.range))
      return () => { registry.delete('pc-reader-quote') }
    } catch { /* The quote preview remains available without the Highlight API. */ }
  }, [selected])

  const loadOlder = async () => {
    const first = messages.find(message => !message.live), signal = requestLife.current?.signal
    if (!first || loadingOlder || !signal) return
    setLoadingOlder(true); const id = sessionId, current = records.current
    try {
      const page = await api.messages(workspaceId, id, signal, first.seq)
      if (signal.aborted || currentId.current !== id) return
      olderScroll.current = scroll.current?.scrollHeight ?? null; nearBottom.current = false; readyForOlder.current = true
      for (const message of page.messages) current.messages.set(message.seq, message)
      current.hasMore = page.hasMore
      setData(data => ({ ...data, messages: [...current.messages.values()].sort((a, b) => a.seq - b.seq), hasMore: page.hasMore }))
    } catch (error) { if (!signal.aborted) setError(errorText(error)) }
    finally { if (!signal.aborted && currentId.current === id) setLoadingOlder(false) }
  }
  const select = (message: Message, element: HTMLElement) => {
    if (message.role !== 'assistant' || message.live) return
    const selection = window.getSelection(); if (!selection || selection.isCollapsed || !selection.rangeCount) return
    const range = selection.getRangeAt(0), quote = selection.toString().trim()
    if (!quote || quote.length > 6000 || !element.contains(range.startContainer) || !element.contains(range.endContainer)) return
    setSelected({ anchor: { sessionId, seq: message.seq, messageHash: message.hash, quote }, range: range.cloneRange() })
  }
  const preview = (exclude: string[]): Promise<ContextPlan> => api.contextPreview(workspaceId, sessionId, exclude)
  const close = () => { if (selected) setSelected(null); else onClose() }
  if (!node) return null
  return <section ref={root} className={`pc-reader${branchesOpen ? '' : ' pc-reader-hide-branches'}`} role="dialog" aria-modal="true" aria-label="对话阅读"
    onKeyDownCapture={event => selectCardBody(event, scroll.current)}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key !== 'Tab') return
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]'))
      const visible = controls.filter(control => !control.closest('[inert]') && getComputedStyle(control).visibility !== 'hidden' && control.getClientRects().length > 0)
      const first = visible[0], last = visible.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>
    <header className="pc-reader-header">
      <nav className="pc-reader-crumbs" aria-label="阅读位置">
        <button onClick={onClose}>Canvas</button><span>›</span>
        {parentId && parentTitle && <><button title={parentTitle} onClick={() => onOpen(parentId)}>{parentTitle}</button><span>›</span></>}
        <strong title={node.title}>{node.title}</strong>
      </nav>
      <PresetPill preset={node.preset}/>
      <div className="pc-reader-actions">
        <button className="pc-reader-icon-action" aria-label={branchesOpen ? '收起分支列表' : '展开分支列表'} title={branchesOpen ? '收起分支列表' : '展开分支列表'}
          aria-expanded={branchesOpen} aria-controls={branchesId} onClick={() => setBranchesOpen(value => !value)}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="2"/><path d="M12.5 3v14"/></svg>
        </button>
        <button aria-label="减小字号" title="减小字号" disabled={fontSize <= 15} onClick={() => { nearBottom.current = false; setFontSize(value => value - 1) }}>A−</button>
        <button aria-label="增大字号" title="增大字号" disabled={fontSize >= 23} onClick={() => { nearBottom.current = false; setFontSize(value => value + 1) }}>A+</button>
        <button className="pc-reader-native pc-reader-icon-action" aria-label="在 DSH 中打开" title="在 DSH 中打开" onClick={() => onOpenNative(sessionId)}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M11 3.5h5.5V9M16.5 3.5l-8 8M8 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3"/></svg>
        </button>
        <button className="pc-reader-back pc-reader-icon-action" aria-label="返回画布" onClick={onClose} title="返回画布（Esc）">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 3v4H3m10-4v4h4M7 17v-4H3m10 4v-4h4M3 3l4 4m10-4-4 4M3 17l4-4m10 4-4-4"/></svg>
        </button>
      </div>
    </header>
    <div className="pc-reader-layout">
      <main className="pc-reader-column">
        <div ref={scroll} className="pc-reader-scroll" tabIndex={0} role="document" aria-label="对话正文" data-pc-select-scope="" onPointerDown={focusCardBody}
          onScroll={event => { const element = event.currentTarget; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90; scrollPositions.current.set(sessionId, element.scrollTop) }}>
          <div className="pc-reader-text" style={{ fontSize }}>
            {ready && data.hasMore && <button className="pc-load" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? '正在读取…' : '加载更早的对话'}</button>}
            <h1>{node.title}</h1>
            {!ready ? <p className="pc-muted">正在读取对话…</p> : !messages.length ? <p className="pc-muted">还没有消息。可点击右上角“在 DSH 中打开”继续对话。</p>
              : messages.map((message, index) => index === 0 && message.role === 'user' && message.text === node.title ? null : <div key={message.seq} className={`pc-reader-message pc-reader-${message.role}`} data-seq={message.seq}>
                {(message.role === 'user' || (message.live && !!message.text)) && <small>{message.role === 'user' ? '提问' : '正在回答…'}</small>}
                <MessageBody message={message} sessionId={sessionId} onSelect={element => select(message, element)}/>
              </div>)}
            {(error || (ready && data.error)) && <p className="pc-error" role="alert">{error || data.error}</p>}
            {ready && data.running && <button className="pc-reader-stop" onClick={() => void api.cancel(workspaceId, sessionId).catch(error => setError(errorText(error)))}>■ 停止生成</button>}
          </div>
        </div>
        <footer className="pc-reader-compose">
          <div className="pc-reader-compose-inner">
            {selected && <div className="pc-reader-selection"><span title={selected.anchor.quote}>引用 · {selected.anchor.quote}</span><button aria-label="取消引用选区" onClick={() => setSelected(null)}>×</button></div>}
            <CardComposer key={sessionId} inline open autoFocus={false} anchor={anchor} readOnly={!ready || !lastAnswer}
              initialText={drafts.get(sessionId) ?? ''} onDraftChange={text => drafts.set(sessionId, text)}
              loadPreview={preview} onOpen={stayOpen} onClose={close} onSubmit={async (...args) => { const id = sessionId; await onSubmit(...args); if (currentId.current === id) setSelected(null) }}/>
            {ready && !lastAnswer && <p className="pc-reader-wait">回答完成后，可以从这里继续追问或记笔记。</p>}
          </div>
        </footer>
      </main>
      <aside ref={branchesRoot} id={branchesId} className="pc-reader-branches" aria-label="分支列表" aria-hidden={!branchesOpen}>
        <header><h2>Branches</h2><span className="pc-branch-count">{branches.length}</span></header>
        <div className="pc-reader-branch-list">
          {branches.map(branch => <button key={branch.sessionId} className="pc-reader-branch" title={branch.title} onClick={() => onOpen(branch.sessionId)}>
            <div className="pc-reader-branch-title"><strong>{branch.title}</strong><PresetPill preset={branch.preset}/></div>
            <span className="pc-reader-branch-open">{branch.running ? <><i className="pc-status pc-status-running"/>正在回答…</> : 'open →'}</span>
          </button>)}
          {!branches.length && <p className="pc-reader-no-branches">从正文选区或下方输入框追问，新的分支会出现在这里。</p>}
        </div>
      </aside>
    </div>
  </section>
}
