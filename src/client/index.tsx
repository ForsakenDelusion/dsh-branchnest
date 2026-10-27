import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CanvasApi } from './api.ts'
import { CanvasPage } from './page.tsx'
import { NativeDrafts, registerNativeComposer } from './native-start.tsx'
import { registerNativeInteractions } from './native-interactions.tsx'
import styles from './style.css'
import { sessionFileResource } from './file-references.ts'

export const name = 'project-canvas-client'
export const inject = ['slots', 'layout', 'connection', 'workspaces', 'sessions', 'uiWorkspace', 'conversation', 'configForms', 'remote', 'remote.agentPresets', 'sidebarRight']
const PANEL = 'project-canvas' as MainPanelId

export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'project-canvas: client requests')
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = styles;
    document.head.append(style); return () => style.remove() }, 'project-canvas: styles')
  const call = async <T,>(endpoint: string, payload: unknown = {}, signal?: AbortSignal): Promise<T> => {
    const result = await connection.rpc.call('/api', 'project-canvas', { endpoint, payload },
      signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
  const workspaces = ctx.get('workspaces') as { list: {
    getSnapshot(): { archivedSessionIds: readonly string[] }; subscribe(listener: () => void): () => void
  } } | undefined
  const archive = async (workspaceId: string, sessionId: string): Promise<void> => {
    // ui-workspace clears the native current session on archive and selects the
    // conversation panel, even when a plugin panel is open. Hold this panel only
    // until the archive projection has arrived; do not redirect other panels.
    let retainCanvas = ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL
    const releasePanel = ctx.layout.panelInfo.subscribe(() => {
      if (!retainCanvas || lifetime.signal.aborted) return
      const current = ctx.layout.panelInfo.getSnapshot().activePanelId
      if (current === null) ctx.layout.selectPanel(PANEL)
      else if (current !== PANEL) retainCanvas = false
    })
    try {
      await call('archive', { workspaceId, sessionId, confirmed: true })
      const source = workspaces?.list
      if (source && !source.getSnapshot().archivedSessionIds.includes(sessionId)) {
        await new Promise<void>(resolve => {
          const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)])
          let release = () => {}, finished = false
          const finish = () => { if (finished) return; finished = true; release(); signal.removeEventListener('abort', finish); resolve() }
          const check = () => { if (source.getSnapshot().archivedSessionIds.includes(sessionId)) finish() }
          release = source.subscribe(check)
          signal.addEventListener('abort', finish, { once: true })
          if (signal.aborted) finish(); else check()
        })
      }
    } finally { releasePanel() }
  }
  const api: CanvasApi = {
    prepareDraft: workspaceId => call('prepareDraft', { workspaceId }),
    projects: signal => call('projects', {}, signal), createProject: path => call('createProject', { path }),
    snapshot: (workspaceId, signal) => call('snapshot', { workspaceId }, signal),
    layout: (workspaceId, patch) => call('layout', { workspaceId, ...patch }),
    messages: (workspaceId, sessionId, signal, beforeSeq) => call('messages', { workspaceId, sessionId, beforeSeq }, signal),
    start: (workspaceId, operationId, question, anchor, parentId, noteId, exclude, preset) => call('start', { workspaceId, operationId, question, anchor, parentId, noteId, exclude, preset }),
    link: (workspaceId, fromId, toId, anchor) => call('link', { workspaceId, fromId, toId, anchor }),
    unlink: (workspaceId, linkId) => call('unlink', { workspaceId, linkId }),
    contextPreview: (workspaceId, sourceId, exclude) => call('contextPreview', { workspaceId, sourceId, exclude }),
    note: (workspaceId, operationId, text, parentId, anchor) => call('note', { workspaceId, operationId, text, parentId, anchor }),
    updateNote: (workspaceId, noteId, text) => call('updateNote', { workspaceId, noteId, text }),
    retry: (workspaceId, operationId) => call('retry', { workspaceId, operationId }),
    send: (workspaceId, sessionId, text, requestId) => call('send', { workspaceId, sessionId, text, requestId }),
    cancel: (workspaceId, sessionId) => call('cancel', { workspaceId, sessionId }),
    archive,
  }
  // Use the sidebar's public navigation capability so the selected native
  // session and main panel change together.
  const openSession = (sessionId: string) => {
    ctx.uiWorkspace.openSession(sessionId as SessionId)
  }
  const sidebarRight = ctx.get('sidebarRight') as { openResource(url: string): void
    mounted: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void } }
  let fileNavigation = 0
  const openFile = async (sessionId: string, path: string) => {
    const request = ++fileNavigation
    // DSH's document sidebar is owned by the native conversation surface.
    // Navigate through its public entry and wait for its session seat, rather
    // than calling a sidebar action while the canvas has no mounted seat.
    openSession(sessionId)
    await new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)])
      let release = () => {}, finished = false
      const finish = (error?: Error) => {
        if (finished) return
        finished = true; release(); signal.removeEventListener('abort', aborted)
        if (error) reject(error); else resolve()
      }
      const check = () => { if (sidebarRight.mounted.getSnapshot() === sessionId) finish() }
      const aborted = () => finish(new Error('文件预览未能打开，请重试'))
      release = sidebarRight.mounted.subscribe(check)
      if (finished) release()
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted(); else check()
    })
    if (request === fileNavigation && !lifetime.signal.aborted) sidebarRight.openResource(sessionFileResource(sessionId, path))
  }
  // Creating a project means adopting a host directory, the same route the native
  // workspace flow takes: Desktop's injected chooser first, then the workspace service.
  const pickDirectory = async (): Promise<string | null> => {
    const desktop = (globalThis as { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
    if (desktop) return desktop.pick()
    const workspace = ctx.get('uiWorkspace') as { pickDirectory(): Promise<string | null> } | undefined
    if (!workspace) throw new Error('当前环境不支持选择目录')
    return workspace.pickDirectory()
  }
  // The canvas is a reading surface: collapse the DSH sidebar while it is the active panel,
  // and restore it only if we were the one who collapsed it.
  let collapsedByCanvas = false
  const sidebarWidth = () => document.querySelector('[data-slot="sidebar"]')?.parentElement?.getBoundingClientRect().width ?? 0
  const enterFullscreen = () => {
    if (collapsedByCanvas || sidebarWidth() <= 120) return
    ctx.layout.toggleSidebar(); collapsedByCanvas = true
  }
  const leaveFullscreen = () => {
    if (!collapsedByCanvas) return
    collapsedByCanvas = false
    if (sidebarWidth() <= 120) ctx.layout.toggleSidebar()
  }
  const drafts = new NativeDrafts(ctx, api)
  ctx.effect(() => () => drafts.dispose(), 'project-canvas: native drafts')
  registerNativeComposer(ctx)
  registerNativeInteractions(ctx)
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL,
    children: { 'project-canvas.new-session': { kind: 'single', scope: 'session' },
      'project-canvas.interactions': { kind: 'single', scope: 'root' } },
    inject: () => ({ api, drafts, openSession, openFile, enterFullscreen, leaveFullscreen, pickDirectory }) }, CanvasPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL,
    order: 5, label: () => '分支探索' }, CanvasIcon))
}

function CanvasIcon({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="8" y="2" width="8" height="6" rx="1.5"/><rect x="2" y="16" width="8" height="6" rx="1.5"/>
    <rect x="14" y="16" width="8" height="6" rx="1.5"/><path d="M12 8v4M6 16v-4h12v4"/>
  </svg>
}
