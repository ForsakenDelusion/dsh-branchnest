import { useEffect, useRef, useState } from 'react'
import type { Anchor, ContextPlan } from '../model.ts'
import { SlimeHandle } from './slime-handle.tsx'
import { BRANCH_PRESETS, PRESET_IDS } from '../presets.ts'
import type { BranchPreset } from '../presets.ts'

export type ComposerAction = 'ask' | 'note'
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

/**
 * The one composer surface for a card: a resting “＋ Ask or note” handle that is
 * only revealed when the pointer is near the card, and a drawer with the three
 * quick questions. Once a draft exists the quick questions yield to Note / Ask.
 */
export function CardComposer({ open, near = false, anchor, readOnly, floating, inline, autoFocus = true, initialText = '', onDraftChange, loadPreview, onOpen, onClose, onSubmit }: {
  open: boolean; near?: boolean; anchor?: Anchor; readOnly?: boolean; floating?: { left: number; top: number };
  inline?: boolean; autoFocus?: boolean; initialText?: string; onDraftChange?(text: string): void;
  loadPreview?(exclude: string[]): Promise<ContextPlan>;
  onOpen(): void; onClose(): void;
  onSubmit(action: ComposerAction, text: string, operationId: string, exclude: string[], preset?: BranchPreset, anchor?: Anchor): Promise<void>
}) {
  const [text, setDraft] = useState(initialText), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const setText = (value: string) => { setDraft(value); onDraftChange?.(value) }
  const [attempt, setAttempt] = useState<{ action: ComposerAction; text: string; id: string; exclude: string[]; preset?: BranchPreset; anchor?: Anchor; submit: typeof onSubmit } | null>(null)
  const [preview, setPreview] = useState<ContextPlan | null>(null), [excluded, setExcluded] = useState<string[]>([]), [showContext, setShowContext] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null), root = useRef<HTMLDivElement>(null), busyRef = useRef(false)
  const previewRef = useRef(loadPreview); previewRef.current = loadPreview
  useEffect(() => { if (open) { setExcluded([]); setShowContext(false) } }, [open, anchor?.seq, anchor?.quote])
  useEffect(() => {
    if (!open || !previewRef.current) { setPreview(null); return }
    const abort = new AbortController()
    previewRef.current(excluded).then(result => { if (!abort.signal.aborted) setPreview(result) })
      .catch(() => { if (!abort.signal.aborted) setPreview(null) })
    return () => abort.abort()
  }, [open, excluded.join('|')])
  useEffect(() => {
    if (!open) return
    if (autoFocus) input.current?.focus({ preventScroll: true })
    if (inline) return
    const outside = (event: PointerEvent) => {
      if (busyRef.current || !(event.target instanceof Node) || root.current?.contains(event.target)) return
      onClose()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, onClose, autoFocus, inline])
  useEffect(() => {
    if (!open || !input.current) return
    const element = input.current
    element.style.height = 'auto'
    element.style.height = `${Math.min(120, element.scrollHeight)}px`
  }, [open, text])
  const submit = async (action: ComposerAction, value = text.trim(), preset?: BranchPreset) => {
    if (!(attempt?.text ?? value) || busyRef.current || readOnly) return
    const request = attempt ?? { action, text: value, id: crypto.randomUUID(), exclude: action === 'ask' ? [...excluded] : [], preset, anchor, submit: onSubmit }
    setAttempt(request); busyRef.current = true; setBusy(true); setError('')
    try { await request.submit(request.action, request.text, request.id, request.exclude, request.preset, request.anchor); setText(''); setAttempt(null) }
    catch (e) { setError(errorText(e)) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const draft = !!text.trim()
  return <div ref={root} className={`pc-composer${open ? ' pc-composer-open' : ''}${floating ? ' pc-composer-floating' : ''}${inline ? ' pc-composer-inline' : ''}`}
    style={floating ? { left: floating.left, top: floating.top } : undefined} onPointerDown={e => e.stopPropagation()}>
    {!floating && !inline && <SlimeHandle active={near} open={open} onClick={() => { if (open) onClose(); else onOpen() }} />}
    {open && <div className="pc-composer-drawer" role="group" aria-label="Ask or note"
      onKeyDown={e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose() } }}>
      {!!preview && (preview.items.length > 0 || preview.omitted.some(entry => entry.reason === 'excluded')) && <div className="pc-context-preview">
        <button type="button" className="pc-context-toggle" aria-expanded={showContext} onClick={() => setShowContext(value => !value)}>
          上下文 · {preview.items.length} 张卡片{preview.omitted.length ? ` · ${preview.omitted.length} 条未包含` : ''}<span>{showContext ? '收起' : '展开'}</span>
        </button>
        {showContext && <ul>
          {preview.items.map(item => <li key={item.cardId}>
            <label title={item.path.join(' → ')}>
              <input type="checkbox" checked disabled={!!attempt} onChange={() => setExcluded(current => [...current, item.cardId])} />
              <span>{item.title}</span>{item.depth > 1 && <small>经 {item.depth - 1} 跳</small>}
            </label>
          </li>)}
          {preview.omitted.filter(entry => entry.reason === 'excluded').map(entry => <li key={entry.cardId}>
            <label title={entry.path.join(' → ')}>
              <input type="checkbox" checked={false} disabled={!!attempt} onChange={() => setExcluded(current => current.filter(id => id !== entry.cardId))} />
              <span>{entry.title ?? entry.cardId}</span><small>已排除</small>
            </label>
          </li>)}
          {!!preview.omitted.filter(entry => entry.reason !== 'excluded').length && <li className="pc-context-omitted">
            {preview.omitted.filter(entry => entry.reason !== 'excluded').map(entry => entry.reason).join(' · ')}
          </li>}
        </ul>}
      </div>}
      <textarea ref={input} aria-label="Ask or note" placeholder="Ask or note…" value={text} rows={2} maxLength={12000}
        disabled={!!attempt || readOnly} onChange={e => setText(e.target.value)} onKeyDown={e => {
          if (e.nativeEvent.isComposing) return
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (!attempt) void submit(e.metaKey || e.ctrlKey ? 'ask' : 'note')
          } else if (!text && !e.metaKey && !e.ctrlKey && !e.altKey && ['1', '2', '3'].includes(e.key)) {
            const preset = PRESET_IDS[Number(e.key) - 1]!
            e.preventDefault(); void submit('ask', BRANCH_PRESETS[preset].question, preset)
          }
        }} />
      {error && <div className="pc-error" role="alert">{error}</div>}
      <footer>{attempt ? <>
        <span className="pc-muted">{busy ? (attempt.action === 'ask' ? '正在创建分支…' : '正在保存笔记…') : '提交未完成'}</span>
        <button disabled={busy} onClick={() => void submit(attempt.action)}>{busy ? '…' : '重试同一次提交'}</button>
      </> : draft ? <>
        <button className="pc-commit pc-commit-note" disabled={busy || readOnly} onClick={() => void submit('note')}>Note <kbd>↵</kbd></button>
        <button className="pc-commit pc-commit-ask" disabled={busy || readOnly} onClick={() => void submit('ask')}>Ask <kbd>⌘↵</kbd></button>
      </> : PRESET_IDS.map((preset, i) => <button key={preset} className="pc-preset" disabled={busy || readOnly}
        title={BRANCH_PRESETS[preset].question} onClick={() => void submit('ask', BRANCH_PRESETS[preset].question, preset)}>{BRANCH_PRESETS[preset].label} <kbd>{i + 1}</kbd></button>)}</footer>
    </div>}
  </div>
}
