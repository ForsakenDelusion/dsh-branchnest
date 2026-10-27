import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContextPlan, NoteCard, Position } from '../model.ts'
import { cardGesture } from './card-gesture.ts'
import { focusCardBody, selectCardBody } from './card-selection.ts'
import type { Composer } from './api.ts'
import { CardComposer } from './ask-dock.tsx'
import type { ComposerAction } from './ask-dock.tsx'
import { SourceAction } from './source-action.tsx'
import type { BranchPreset } from '../presets.ts'
import type { Anchor } from '../model.ts'

const labels = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '参考注释' }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export function NoteNode({ note, zoom, focused, near, composer, sourceTitle, loadPreview, linkTarget, fresh, onLinkDrag, onSaveNote, onEditingChange,
  onFocus, onPosition, onPositionEnd, onReveal, onCompose, onCloseCompose, onSubmitCompose }: {
  note: NoteCard; zoom: number; focused: boolean; near: boolean; composer?: Composer; sourceTitle?: string; loadPreview?(exclude: string[]): Promise<ContextPlan>;
  linkTarget?: boolean; fresh?: boolean; onLinkDrag?(event: import('react').PointerEvent): void;
  onSaveNote(text: string): Promise<void>; onEditingChange(active: boolean): void;
  onFocus(): void; onPosition(p: Position): void; onPositionEnd(p: Position): void; onReveal(id: string): void;
  onCompose(): void; onCloseCompose(): void;
  onSubmitCompose(action: ComposerAction, text: string, operationId: string, exclude: string[], preset?: BranchPreset, anchor?: Anchor): Promise<void>
}) {
  const p = note.position
  const [editing, setEditing] = useState(false), [draft, setDraft] = useState(note.text)
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [expanded, setExpanded] = useState<HTMLElement | null>(null)
  const editor = useRef<HTMLTextAreaElement>(null), body = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null), overlay = useRef<HTMLDivElement>(null), expandButton = useRef<HTMLButtonElement>(null)
  const original = useRef(note.text), text = useRef(note.text), submitting = useRef(false), alive = useRef(true)
  const composing = useRef(false), pendingExit = useRef(false), readingTop = useRef(0)
  const caret = useRef({ start: 0, end: 0 }), notifyEditing = useRef(onEditingChange)
  notifyEditing.current = onEditingChange
  const startEdit = () => {
    if (editing || submitting.current) return
    const quote = window.getSelection()?.toString() ?? '', index = quote ? note.text.indexOf(quote) : -1
    caret.current = index < 0 ? { start: note.text.length, end: note.text.length } : { start: index, end: index + quote.length }
    readingTop.current = body.current?.scrollTop ?? 0
    original.current = note.text; text.current = note.text
    setDraft(note.text); setError(''); setEditing(true)
  }
  const cancel = () => {
    if (submitting.current) return
    pendingExit.current = false; text.current = note.text
    setDraft(note.text); setError(''); setEditing(false)
  }
  const save = async () => {
    if (!editing || submitting.current) return
    if (composing.current) { pendingExit.current = true; return }
    pendingExit.current = false
    const value = text.current.trim()
    if (value === original.current.trim()) { setEditing(false); setError(''); return }
    if (!value) { setError('笔记不能为空，按 Esc 可恢复原文。'); return }
    submitting.current = true; setSaving(true); setError('')
    try { await onSaveNote(value); if (alive.current) setEditing(false) }
    catch (e) { if (alive.current) setError(`未能保存，修改仍保留在这里。${errorText(e)}`) }
    finally { submitting.current = false; if (alive.current) setSaving(false) }
  }
  const saveRef = useRef(save); saveRef.current = save
  useEffect(() => { alive.current = true; return () => { alive.current = false; notifyEditing.current(false) } }, [])
  useEffect(() => { notifyEditing.current(editing || saving || !!expanded) }, [editing, saving, expanded])
  const toggleExpanded = () => {
    readingTop.current = (editing ? editor.current : body.current)?.scrollTop ?? 0
    setExpanded(current => current ? null : article.current?.closest<HTMLElement>('.pc-root') ?? null)
  }
  useEffect(() => {
    if (!expanded) return
    const siblings = Array.from(expanded.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay.current)
    const previous = siblings.map(element => element.inert)
    siblings.forEach(element => { element.inert = true })
    expandButton.current?.focus({ preventScroll: true })
    return () => {
      siblings.forEach((element, index) => { element.inert = previous[index]! })
      expandButton.current?.focus({ preventScroll: true })
    }
  }, [expanded])
  useEffect(() => {
    if (!editing) {
      if (body.current) body.current.scrollTop = readingTop.current
      if (expanded) expandButton.current?.focus({ preventScroll: true })
      return
    }
    editor.current?.focus({ preventScroll: true })
    editor.current?.setSelectionRange(caret.current.start, caret.current.end)
    if (editor.current) editor.current.scrollTop = readingTop.current
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !editor.current?.contains(event.target)) void saveRef.current()
    }
    // Canvas panning prevents native blur, so capture the outside press as well.
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [editing, expanded])
  const card = <article ref={article} className={`pc-card pc-note${focused ? ' pc-focused' : ''}${near ? ' pc-near' : ''}${composer ? ' pc-ask-open' : ''}${linkTarget ? ' pc-link-target' : ''}${editing ? ' pc-note-editing' : ''}${fresh && !expanded ? ' pc-card-fresh' : ''}`} data-note-id={note.id}
    style={expanded ? { left: 0, top: 0, width: '100%', height: '100%' } : { left: p.x, top: p.y, width: p.width, height: p.collapsed ? 48 : p.height }} onPointerDown={onFocus}
    onKeyDownCapture={event => selectCardBody(event, body.current)}>
    <div className="pc-card-surface">
      <header className="pc-card-header" onPointerDown={e => { if (!expanded) cardGesture(e, 'move', p, zoom, onFocus, onPosition, onPositionEnd) }}>
        <strong>Note</strong>
        {saving && <small className="pc-note-status" role="status">保存中…</small>}
        {!expanded && <>
          <SourceAction title={sourceTitle ?? '来源卡片'} quote={note.anchor?.quote} onClick={() => onReveal(note.parentId)}/>
          {onLinkDrag && <button className="pc-link-handle" title="拖到另一张卡片，把它的内容加入本卡上下文" aria-label="拖拽添加上下文" onPointerDown={onLinkDrag}>⇢</button>}
          <button aria-label={p.collapsed ? '展开笔记' : '收起笔记'} onClick={() => onPositionEnd({ ...p, collapsed: !p.collapsed })}>{p.collapsed ? '＋' : '−'}</button>
        </>}
        <button ref={expandButton} aria-label={expanded ? '退出全屏' : '全屏阅读笔记'} title={expanded ? '退出全屏（Esc）' : '全屏阅读笔记'} onClick={toggleExpanded}>{expanded ? '↙' : '⛶'}</button>
      </header>
      {(!p.collapsed || expanded) && <>
        {editing ? <textarea ref={editor} className="pc-note-input pc-scroll" value={draft} maxLength={12000} spellCheck={false}
          aria-label="笔记正文（Markdown）" aria-invalid={!!error} readOnly={saving}
          onChange={e => { text.current = e.target.value; setDraft(e.target.value) }} onBlur={() => void saveRef.current()}
          onCompositionStart={() => { composing.current = true }} onCompositionEnd={e => {
            composing.current = false; text.current = e.currentTarget.value; setDraft(e.currentTarget.value)
            if (pendingExit.current) void saveRef.current()
          }} onKeyDown={e => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel() }
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveRef.current() }
          }}/>
          : <div ref={body} className="pc-note-body pc-scroll pc-markdown" title="双击编辑" onDoubleClick={startEdit}
            tabIndex={0} data-pc-select-scope="" aria-label="笔记正文" onPointerDown={focusCardBody}>
            <MarkdownText text={note.text} labels={labels}/>
          </div>}
        {error && <p className="pc-note-error" role="alert">{error}</p>}
        {!expanded && <div className="pc-resize" title="调整卡片大小" onPointerDown={e => cardGesture(e, 'resize', p, zoom, onFocus, onPosition, onPositionEnd)} />}
      </>}
    </div>
    {!expanded && !p.collapsed && !editing && <CardComposer open={!!composer} near={near} loadPreview={loadPreview} onOpen={onCompose} onClose={onCloseCompose} onSubmit={onSubmitCompose} />}
  </article>
  return expanded ? createPortal(<div ref={overlay} className="pc-note-fullscreen" role="dialog" aria-modal="true" aria-label="笔记阅读"
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); toggleExpanded() }
      if (event.key !== 'Tab') return
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),a[href]'))
      const first = controls[0], last = controls.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}><div className="pc-note-reader">{card}</div></div>, expanded) : card
}
