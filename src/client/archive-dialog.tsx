import { useEffect, useId, useRef, useState } from 'react'

export function ArchiveIcon({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="3" y="3.5" width="14" height="3" rx=".9"/>
    <path d="M4.3 6.5v9a1 1 0 0 0 1 1h9.4a1 1 0 0 0 1-1v-9M7.5 9.5h5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
}

export function ArchiveDialog({ title, onClose, onConfirm }: {
  title: string; onClose(): void; onConfirm(): Promise<void>
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submitting = useRef(false), cancel = useRef<HTMLButtonElement>(null)
  const titleId = useId(), descriptionId = useId()
  useEffect(() => {
    const previous = document.activeElement; cancel.current?.focus({ preventScroll: true })
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const close = () => { if (!submitting.current) onClose() }
  const confirm = async () => {
    if (submitting.current) return
    submitting.current = true; setBusy(true); setError('')
    try { await onConfirm() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); submitting.current = false; setBusy(false) }
  }
  return <div className="pc-modal-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close() }} onKeyDown={e => {
    e.stopPropagation()
    if (e.key === 'Escape') { e.preventDefault(); close() }
    if (e.key === 'Tab') {
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const first = buttons[0], last = buttons.at(-1)
      if (!first || !last) { e.preventDefault(); return }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
  }}>
    <div className="pc-dialog pc-archive-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy}>
      <header><h2 id={titleId}><ArchiveIcon size={19}/>归档这段对话？</h2><button disabled={busy} onClick={close} aria-label="关闭确认框">×</button></header>
      <div className="pc-archive-title" title={title}>{title}</div>
      <p id={descriptionId}>归档后，这张对话卡片会从画布中移除。聊天记录将保留，可在 DSH 的已归档对话中恢复。</p>
      <p className="pc-muted">此对话仍在进行的任务也会停止。</p>
      {error && <p className="pc-error" role="alert">{error}</p>}
      <footer><button ref={cancel} disabled={busy} onClick={close}>取消</button>
        <button className="pc-archive-confirm" disabled={busy} onClick={() => void confirm()}>{busy ? '正在归档…' : '确认归档'}</button></footer>
    </div>
  </div>
}
