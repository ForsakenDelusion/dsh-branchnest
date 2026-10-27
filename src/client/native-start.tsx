import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { AgentPresetRow } from '@deepseek-ai/dsh-agent-preset-registry/types'
import { isBuiltInPreset } from '@deepseek-ai/dsh-agent-preset-registry/display'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Menu, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CanvasApi } from './api.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { projectCanvasDraft: true }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'project-canvas.new-session': {
      kind: 'single'; scope: 'session'
      owner: { onCreated(id: string): void; onBusy(busy: boolean): void }
    }
  }
}

export type NativeComposerSlots = PropsRenderSlots<'project-canvas.new-session'>

/** Retain native input machines (including attachment objects) while their project draft is unsent. */
export class NativeDrafts {
  private entries = new Map<string, Promise<SessionReference>>()
  private disposed = false
  constructor(private ctx: Context, private api: CanvasApi) {}

  acquire(workspaceId: string): Promise<SessionReference> {
    const existing = this.entries.get(workspaceId)
    if (existing) return existing.then(reference => {
      try {
        const snapshot = reference.binding.session.getSnapshot()
        if (snapshot.blank && !snapshot.removed) return reference
      } catch { /* A reconnected native generation requires a fresh reference. */ }
      if (this.entries.get(workspaceId) === existing) this.finish(workspaceId)
      return this.acquire(workspaceId)
    })
    const pending = this.open(workspaceId)
    this.entries.set(workspaceId, pending)
    void pending.catch(() => { if (this.entries.get(workspaceId) === pending) this.entries.delete(workspaceId) })
    return pending
  }
  private async open(workspaceId: string): Promise<SessionReference> {
    const { sessionId } = await this.api.prepareDraft(workspaceId)
    if (this.disposed) throw new Error('画布已关闭')
    await this.ctx.sessions.refresh()
    if (this.disposed) throw new Error('画布已关闭')
    const reference = this.ctx.sessions.retain(sessionId as SessionId, { source: 'projectCanvasDraft' })
    try {
      await reference.ready
      if (this.disposed) throw new Error('画布已关闭')
      return reference
    } catch (error) { reference.release(); throw error }
  }
  finish(workspaceId: string): void {
    const entry = this.entries.get(workspaceId)
    this.entries.delete(workspaceId)
    void entry?.then(reference => reference.release(), () => {})
  }
  dispose(): void {
    this.disposed = true
    for (const id of this.entries.keys()) this.finish(id)
  }
}

interface PresetControls {
  readPresets(): Promise<readonly AgentPresetRow[]>
  selectPreset(sessionId: SessionId, preset: string): Promise<void>
  codingTools: ObservableSnapshot<boolean>
}
type ComposerEvents = PresetControls & { onCreated(id: string): void; onBusy(busy: boolean): void; onLock(value: boolean): void }
const ComposerEventsContext = createContext<ComposerEvents | null>(null)

/** The Factory's local View seat can reuse its authorized native slots without redeclaring them. */
function NativeOptions({ sessionId, useSession, useInput, useSessions, renderSlot }: ConversationViewsProps) {
  const events = useContext(ComposerEventsContext)!
  const session = useSession(value => value)
  const input = useInput(value => value)
  const busy = input.phase === 'adjudicating' || input.phase === 'submitting'
  const [presets, setPresets] = useState<readonly AgentPresetRow[]>([]), [open, setOpen] = useState(false)
  const [selecting, setSelecting] = useState(false), [error, setError] = useState('')
  const current = useSessions(value => value.byId[sessionId]?.projectionValues?.agentPreset)
  const codingTools = useSyncExternalStore(
    useCallback(listener => events.codingTools.subscribe(listener), [events.codingTools]),
    useCallback(() => events.codingTools.getSnapshot(), [events.codingTools]),
  )
  useEffect(() => {
    let active = true
    void events.readPresets().then(value => { if (active) setPresets(value) }, reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [events.readPresets])
  const options = presets.filter(preset => preset.broken === undefined
    && (codingTools || !isBuiltInPreset(preset) || !['ptc', 'minimal'].includes(preset.id)))
  const label = (preset: AgentPresetRow) => isBuiltInPreset(preset)
    ? ({ standard: '标准模式', ptc: 'PTC 模式', minimal: '极简模式', cordis: '创作者模式' }[preset.id] ?? preset.id)
    : preset.name ?? preset.id
  const chosen = presets.find(preset => preset.id === current) ?? presets.find(preset => preset.isDefault)
  const select = async (id: string) => {
    setOpen(false)
    if (busy || selecting || id === current) return
    events.onLock(true); setSelecting(true); setError('')
    try { await events.selectPreset(sessionId, id) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { events.onLock(false); setSelecting(false) }
  }
  const published = useRef(false)
  useEffect(() => { events.onBusy(busy || selecting) }, [busy, selecting, events.onBusy])
  useEffect(() => {
    // Acceptance, not an attempted send: a rejected prompt keeps its editable draft.
    if (published.current || session.blank || session.promptError || busy || session.pendingSubmissions.length > 0) return
    published.current = true
    events.onCreated(sessionId)
  }, [session, busy, sessionId, events.onCreated])
  return <div className="pc-native-options">
    {options.length > 0 && <Menu open={open} onClose={() => setOpen(false)} portal compact
      items={options.map(preset => ({ id: preset.id, label: label(preset) }))} selectedId={typeof current === 'string' ? current : chosen?.id}
      onSelect={id => { void select(id) }} anchor={<button className="pc-native-preset" type="button" aria-label="选择模式"
        aria-haspopup="menu" aria-expanded={open} disabled={busy || selecting || !session.blank} onClick={() => setOpen(value => !value)}>
        {selecting ? '正在切换…' : chosen ? label(chosen) : '选择模式'}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true"><path d="m2.5 3.5 2.5 3 2.5-3" /></svg>
      </button>} />}
    {renderSlot('conversation.hero.options', {})}
    {error && <span className="pc-native-preset-error" role="alert">{error}</span>}
  </div>
}

type ComposerProps = PropsRuntime<'project-canvas.new-session'> & PropsRenderFactories & PresetControls & { focusInput(): void }

/** Native Factory owns uploads, command menus, model policy and all installed contributions. */
function NativeComposer({ renderFactorySlot, focusInput, readPresets, selectPreset, codingTools, onCreated, onBusy }: ComposerProps) {
  const root = useRef<HTMLDivElement>(null)
  const onLock = useCallback((value: boolean) => { if (root.current) root.current.inert = value }, [])
  useEffect(() => { focusInput() }, [focusInput])
  return <ComposerEventsContext.Provider value={{ onCreated, onBusy, onLock, readPresets, selectPreset, codingTools }}>
    <div className="pc-native-composer" ref={root}>
      {renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
        slots: { views: NativeOptions },
      })}
    </div>
  </ComposerEventsContext.Provider>
}

export function registerNativeComposer(ctx: Context): void {
  ctx.slots.inject('project-canvas.new-session', () => ctx.slots.register({
    name: 'project-canvas.new-session',
    inject: (sessionId: SessionId) => ({
      focusInput: () => { const scope = ctx.sessions.scope(sessionId); if (scope) ctx.conversation.input.for(scope).focus() },
      codingTools: ctx.configForms.developerTools.enabled,
      readPresets: async () => {
        const result = await ctx.remote.agentPresets.list()
        if (!result.ok) {
          if (result.error.code === 'gateway/invocation-unavailable') return []
          throw new Error(result.error.message)
        }
        return result.value.presets
      },
      selectPreset: async (id: SessionId, preset: string) => {
        const result = await ctx.remote.agentPresets.select(id, preset)
        if (!result.ok) throw new Error(result.error.message)
        await ctx.sessions.refreshProjections(id)
      },
    }),
  }, NativeComposer))
}

export function NativeStartDialog({ workspaceId, drafts, SessionProvider, renderSlot, onClose, onCreated }: NativeComposerSlots & {
  workspaceId: string; drafts: NativeDrafts; onClose(): void; onCreated(id: string): void
}) {
  const [reference, setReference] = useState<SessionReference | null>(null)
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false)
  const accepted = useRef(false), busyRef = useRef(false), maskClick = useRef(false)
  const onBusy = useCallback((value: boolean) => { busyRef.current = value; setBusy(value) }, [])
  const created = useCallback((id: string) => { accepted.current = true; onCreated(id) }, [onCreated])
  // The blank area around the composer must not dismiss an unsent draft: a mask
  // click is swallowed, while the close button and Escape keep the documented exits.
  useEffect(() => {
    const mark = (event: MouseEvent) => {
      const dialog = document.querySelector('.pc-native-start')
      if (dialog?.contains(event.target as Node)) return
      maskClick.current = true
      window.setTimeout(() => { maskClick.current = false }, 0)
    }
    document.addEventListener('click', mark, true)
    return () => document.removeEventListener('click', mark, true)
  }, [])
  useEffect(() => {
    let active = true
    setError('')
    void drafts.acquire(workspaceId).then(value => { if (active) setReference(value) }, reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { active = false }
  }, [workspaceId, drafts, attempt])
  useEffect(() => () => { if (accepted.current) drafts.finish(workspaceId) }, [workspaceId, drafts])
  return <Modal open headless title="新建对话" className="pc-native-start" onClose={() => {
    if (busyRef.current || maskClick.current) return
    onClose()
  }}>
      <button className="pc-native-close" type="button" aria-label="关闭" title="关闭" disabled={busy} onClick={onClose}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
      </button>
    {reference ? <SessionProvider session={reference}>
      {renderSlot('project-canvas.new-session', { onCreated: created, onBusy })}
    </SessionProvider> : error ? <div className="pc-native-status" role="alert">{error}
      <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>
    </div> : <div className="pc-native-status" role="status">正在准备输入器…</div>}
  </Modal>
}
