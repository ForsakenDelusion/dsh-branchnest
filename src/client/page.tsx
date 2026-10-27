import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Anchor, ContextPlan, Position, Project, Snapshot, Viewport } from '../model.ts'
import type { CanvasApi, Composer, Selection } from './api.ts'
import { SessionNode } from './session-node.tsx'
import { NoteNode } from './note-node.tsx'
import { CardComposer } from './ask-dock.tsx'
import type { ComposerAction } from './ask-dock.tsx'
import { ArchiveDialog } from './archive-dialog.tsx'
import { SessionReader } from './session-reader.tsx'
import type { BranchPreset } from '../presets.ts'
import { NativeStartDialog } from './native-start.tsx'
import type { NativeComposerSlots, NativeDrafts } from './native-start.tsx'
import { NativeInteractions } from './native-interactions.tsx'
import type { NativeInteractionsSlots } from './native-interactions.tsx'
import { CanvasFiles } from './file-links.tsx'
import type { OpenCanvasFile } from './file-links.tsx'
import { WheelZoom, limitZoom } from './wheel-zoom.ts'

function ProjectGlyph() {
  return <svg className="pc-project-glyph" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2.6"/>
    <path d="M5.5 6.4h5M5.5 9.6h5" strokeLinecap="round"/>
  </svg>
}
function ProjectCaret() {
  return <svg className="pc-caret" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M3 4.75 6 7.75 9 4.75" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
}
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
/** How far (in screen px) the pointer may sit from a card before its Ask handle fades in. */
const NEAR_MARGIN = 36
const ARRANGE_GAP_X = 90, ARRANGE_GAP_Y = 100, ARRANGE_ORIGIN = 40
const ARRANGE_GRID_X = 560, ARRANGE_GRID_Y = 640

export function CanvasPage({ api, drafts, SessionProvider, renderSlot, useSessions, useWorkspaces, openSession, openFile, enterFullscreen, leaveFullscreen, pickDirectory }: NativeComposerSlots & NativeInteractionsSlots & Pick<PropsRuntime<'main'>, 'useSessions' | 'useWorkspaces'> & { api: CanvasApi; drafts: NativeDrafts; openSession(sessionId: string): void; openFile?: OpenCanvasFile; enterFullscreen?(): void; leaveFullscreen?(): void; pickDirectory?: () => Promise<string | null> }) {
  const nativeSessionId = useSessions(value => Object.values(value.byId).find(item => (item.retainedBy.mainView ?? 0) > 0)?.id)
  const nativeWorkspaceId = useWorkspaces(value => value.items.find((item: { workspaceId: string; sessionIds: readonly string[] }) => nativeSessionId && item.sessionIds.includes(nativeSessionId))?.workspaceId)
  const entryTarget = useRef<{ workspaceId: string; sessionId: string } | null>(null)
  const [projects, setProjects] = useState<Project[]>([]), [projectId, setProjectId] = useState('')
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [error, setError] = useState('')
  const [viewport, setViewport] = useState<Viewport>({ x: 40, y: 40, zoom: .85 })
  const viewportRef = useRef(viewport); viewportRef.current = viewport
  const cancelWheel = useRef(() => {})
  const [size, setSize] = useState({ width: 1000, height: 800 })
  const [focus, setFocus] = useState(''), [highlight, setHighlight] = useState<{ sessionId: string; seq: number } | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [near, setNear] = useState('')
  const [readerId, setReaderId] = useState('')
  const readerDrafts = useRef(new Map<string, string>())
  const closeReader = useCallback(() => setReaderId(''), [])
  const [linkDrag, setLinkDrag] = useState<{ fromId: string; from: { x: number; y: number }; to: { x: number; y: number }; targetId?: string } | null>(null)
  const [projectsOpen, setProjectsOpen] = useState(false)
  const [projectBusy, setProjectBusy] = useState(false)
  const [projectError, setProjectError] = useState('')
  const pendingProject = useRef('')
  const [freshCardId, setFreshCardId] = useState('')
  const [editingNotes, setEditingNotes] = useState<Set<string>>(() => new Set())
  const trackNoteEditing = useCallback((id: string, active: boolean) => {
    setEditingNotes(current => {
      if (current.has(id) === active) return current
      const next = new Set(current); if (active) next.add(id); else next.delete(id)
      return next
    })
  }, [])
  const projectsRef = useRef<HTMLElement>(null), projectToggleRef = useRef<HTMLButtonElement>(null)
  const [hoverLink, setHoverLink] = useState('')
  const selectionRef = useRef<Selection | null>(null); selectionRef.current = selection
  const nearRef = useRef('')
  const [composer, setComposer] = useState<Composer | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<{ sessionId: string; title: string } | null>(null)
  const quoteHighlight = useRef<unknown>(null)
  const clearQuoteHighlight = useCallback(() => {
    try { (CSS as unknown as { highlights?: { delete(name: string): void } }).highlights?.delete('pc-quote') } catch { /* unsupported */ }
    quoteHighlight.current = null
  }, [])
  const showQuoteHighlight = (range?: Range) => {
    clearQuoteHighlight()
    if (!range) return
    try {
      const registry = (CSS as unknown as { highlights?: { set(name: string, highlight: unknown): void } }).highlights
      const HighlightCtor = (globalThis as unknown as { Highlight?: new (range: Range) => unknown }).Highlight
      if (!registry || !HighlightCtor) return
      const highlight = new HighlightCtor(range.cloneRange())
      registry.set('pc-quote', highlight); quoteHighlight.current = highlight
    } catch { /* the quote line in the composer still carries the selection */ }
  }
  const closeComposer = useCallback(() => { setComposer(null); clearQuoteHighlight() }, [clearQuoteHighlight])
  const [dialog, setDialog] = useState(false)
  const stage = useRef<HTMLDivElement>(null), editing = useRef(false), generation = useRef(0), seeded = useRef(false)
  const panning = useRef(false)
  const fitAfterArrange = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealAfterCreate = useRef('')
  const projectRef = useRef(projectId); projectRef.current = projectId

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    try { const items = await api.projects(signal); if (signal?.aborted) return
      setProjects(items)
      const pending = pendingProject.current
      if (pending && items.some(project => project.id === pending)) pendingProject.current = ''
      setProjectId(id => pending || (items.some(project => project.id === id) ? id : items[0]?.id ?? ''))
      setError('')
    } catch (e) { if (!signal?.aborted) setError(errorText(e)) }
  }, [api])
  useEffect(() => {
    const abort = new AbortController()
    void loadProjects(abort.signal); const timer = setInterval(() => void loadProjects(abort.signal), 5000)
    return () => { abort.abort(); clearInterval(timer) }
  }, [loadProjects])

  // The native main-view reference survives panel navigation. Follow its actual
  // workspace once the catalogs arrive, including when they load after this page.
  // Polling must not undo a project the user subsequently selects on the canvas.
  useEffect(() => {
    if (!nativeSessionId || !nativeWorkspaceId) return
    entryTarget.current = { workspaceId: nativeWorkspaceId, sessionId: nativeSessionId }
    setProjectId(nativeWorkspaceId)
  }, [nativeSessionId, nativeWorkspaceId])

  useEffect(() => { enterFullscreen?.(); return () => leaveFullscreen?.() }, [])
  useEffect(() => {
    if (!projectsOpen) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (projectsRef.current?.contains(target) || projectToggleRef.current?.contains(target)) return
      setProjectsOpen(false)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setProjectsOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [projectsOpen])
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!projectId || editing.current) return
    const version = generation.current
    try { const state = await api.snapshot(projectId, signal)
      if (signal?.aborted || projectRef.current !== projectId || version !== generation.current || editing.current) return
      setSnapshot(state); setError('')
      if (!seeded.current) { setViewport(state.viewport); seeded.current = true }
    } catch (e) { if (!signal?.aborted) setError(errorText(e)) }
  }, [api, projectId])

  const addProject = async () => {
    if (projectBusy || !pickDirectory) return
    setProjectBusy(true); setProjectError('')
    try {
      const path = await pickDirectory()
      if (!path) return
      const project = await api.createProject(path)
      pendingProject.current = project.id
      setProjects(current => current.some(item => item.id === project.id) ? current : [project, ...current])
      setProjectId(project.id); setProjectsOpen(false)
      void loadProjects()
    } catch (e) { setProjectError(errorText(e)) }
    finally { setProjectBusy(false) }
  }

  useEffect(() => {
    setSnapshot(null); setSelection(null); setComposer(null); setDialog(false); setArchiveTarget(null); setReaderId(''); readerDrafts.current.clear(); setEditingNotes(new Set()); seeded.current = false; generation.current++
    const abort = new AbortController(); void refresh(abort.signal)
    const timer = setInterval(() => void refresh(abort.signal), 2500)
    return () => { abort.abort(); clearInterval(timer); if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [refresh])
  useEffect(() => {
    if (!stage.current) return
    const observer = new ResizeObserver(([entry]) => { if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height }) })
    observer.observe(stage.current); return () => observer.disconnect()
  }, [])

  const changeViewport = useCallback((next: Viewport, fromWheel = false) => {
    if (!fromWheel) cancelWheel.current()
    viewportRef.current = next; setViewport(next); setSelection(null); clearQuoteHighlight()
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const project = projectRef.current
    saveTimer.current = setTimeout(() => { if (project) void api.layout(project, { viewport: next }).catch(e => setError(errorText(e))) }, 250)
  }, [api, clearQuoteHighlight])

  const previewFile = useCallback(async (sessionId: string, path: string) => {
    cancelWheel.current()
    if (saveTimer.current) {
      clearTimeout(saveTimer.current); saveTimer.current = null
      if (projectRef.current) await api.layout(projectRef.current, { viewport: viewportRef.current })
    }
    await openFile?.(sessionId, path)
  }, [api, openFile])

  useEffect(() => {
    const element = stage.current; if (!element) return
    const motion = new WheelZoom(), reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frame = 0, previous = 0
    const cancel = () => { if (frame) cancelAnimationFrame(frame); frame = 0; previous = 0; motion.reset() }
    cancelWheel.current = cancel
    const tick = (time: number) => {
      const next = motion.step(viewportRef.current, previous ? time - previous : 16, reduced.matches)
      previous = time
      if (next) { changeViewport(next, true); frame = requestAnimationFrame(tick) }
      else { frame = 0; previous = 0 }
    }
    const wheel = (event: WheelEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.pc-card,input,textarea,select,[contenteditable]') && !event.ctrlKey && !event.metaKey) { cancel(); return }
      event.preventDefault()
      const bounds = element.getBoundingClientRect()
      if (motion.push(event, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, bounds.height) && !frame)
        frame = requestAnimationFrame(tick)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('pointerdown', cancel, true)
    window.addEventListener('blur', cancel)
    return () => { cancel(); element.removeEventListener('wheel', wheel); element.removeEventListener('pointerdown', cancel, true); window.removeEventListener('blur', cancel) }
  }, [changeViewport, projectId])

  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.pc-card,button,input,textarea,select,.pc-context-overlay')) return
    event.preventDefault()
    setSelection(null); clearQuoteHighlight(); const element = event.currentTarget, start = viewportRef.current
    const x = event.clientX, y = event.clientY; panning.current = true; element.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => changeViewport({ ...start, x: start.x + e.clientX - x, y: start.y + e.clientY - y })
    const end = () => { panning.current = false; element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', end) }
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', end, { once: true }); element.addEventListener('pointercancel', end, { once: true })
  }
  // Reveal a card's Ask handle when the pointer comes near it, not only when it is on the card.
  const pointerNear = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panning.current || event.pointerType !== 'mouse' || !snapshot) return
    const bounds = stage.current?.getBoundingClientRect(); if (!bounds) return
    const v = viewportRef.current, margin = NEAR_MARGIN / v.zoom
    const x = (event.clientX - bounds.left - v.x) / v.zoom, y = (event.clientY - bounds.top - v.y) / v.zoom
    let id = ''
    for (const [cardId, p] of [...snapshot.nodes.map(n => [n.sessionId, n.position] as const), ...snapshot.notes.map(n => [n.id, n.position] as const)]) {
      if (x >= p.x - margin && x <= p.x + p.width + margin && y >= p.y - margin && y <= p.y + (p.collapsed ? 48 : p.height) + margin) id = cardId
    }
    const cardElement = (cardId: string) => document.querySelector<HTMLElement>(`[data-session-id="${cardId}"],[data-note-id="${cardId}"]`)
    const clearSlime = (cardId: string) => {
      const element = cardElement(cardId); if (!element) return
      element.style.removeProperty('--pc-slime-x'); element.style.removeProperty('--pc-slime-y'); element.style.removeProperty('--pc-slime-proximity')
    }
    if (nearRef.current && nearRef.current !== id) { clearSlime(nearRef.current); nearRef.current = '' }
    if (id) {
      nearRef.current = id
      const element = cardElement(id)
      if (element) {
        const bounds = element.getBoundingClientRect()
        const dx = event.clientX - (bounds.left + bounds.width / 2)
        const dy = event.clientY - (bounds.top + bounds.height)
        const proximity = Math.max(0, 1 - Math.hypot(dx, dy) / (180 * v.zoom))
        const leanX = Math.max(-2, Math.min(2, dx / v.zoom * 0.035)) * proximity
        const leanY = Math.max(-.8, Math.min(1, dy / v.zoom * 0.035)) * proximity
        element.style.setProperty('--pc-slime-x', `${leanX.toFixed(1)}px`)
        element.style.setProperty('--pc-slime-y', `${leanY.toFixed(1)}px`)
        element.style.setProperty('--pc-slime-proximity', proximity.toFixed(3))
      }
    }
    setNear(current => current === id ? current : id)
  }
  const updatePosition = (id: string, position: Position, final = false) => {
    generation.current++; editing.current = !final
    setSnapshot(s => s && ({ ...s, nodes: s.nodes.map(n => n.sessionId === id ? { ...n, position } : n), notes: s.notes.map(n => n.id === id ? { ...n, position } : n) }))
    if (final) { editing.current = true
      void api.layout(projectId, { sessionId: id, position }).then(() => { editing.current = false; void refresh() })
        .catch(e => { editing.current = false; setError(errorText(e)) }) }
  }
  const reveal = (id: string, seq?: number) => {
    const node = snapshot?.nodes.find(n => n.sessionId === id) ?? snapshot?.notes.find(n => n.id === id); if (!node) return
    setFocus(id); if (seq !== undefined) setHighlight({ sessionId: id, seq })
    if (node.position.collapsed) updatePosition(id, { ...node.position, collapsed: false }, true)
    const z = Math.max(.75, viewport.zoom), width = stage.current?.clientWidth ?? size.width, height = stage.current?.clientHeight ?? size.height
    changeViewport({ x: width / 2 - (node.position.x + node.position.width / 2) * z,
      y: height / 2 - (node.position.y + node.position.height / 2) * z, zoom: z })
  }
  useEffect(() => {
    const target = entryTarget.current
    if (target?.workspaceId === projectId && snapshot?.nodes.some(node => node.sessionId === target.sessionId)) {
      entryTarget.current = null
      reveal(target.sessionId)
    }
  }, [snapshot, projectId])
  useEffect(() => {
    const id = revealAfterCreate.current
    if (id && (snapshot?.nodes.some(n => n.sessionId === id) || snapshot?.notes.some(n => n.id === id))) {
      revealAfterCreate.current = ''; reveal(id)
      setFreshCardId(id)
      window.setTimeout(() => setFreshCardId(current => current === id ? '' : current), 900)
    }
  }, [snapshot])
  const fit = () => {
    if (!snapshot || !(snapshot.nodes.length + snapshot.notes.length)) return
    const positions = [...snapshot.nodes, ...snapshot.notes].map(n => n.position), left = Math.min(...positions.map(p => p.x)), top = Math.min(...positions.map(p => p.y))
    const right = Math.max(...positions.map(p => p.x + p.width)), bottom = Math.max(...positions.map(p => p.y + (p.collapsed ? 48 : p.height)))
    const width = stage.current?.clientWidth ?? size.width, height = stage.current?.clientHeight ?? size.height
    const z = limitZoom(Math.min((width - 100) / (right - left), (height - 100) / (bottom - top), 1))
    changeViewport({ x: (width - (right - left) * z) / 2 - left * z, y: (height - (bottom - top) * z) / 2 - top * z, zoom: z })
  }
  useEffect(() => {
    if (!fitAfterArrange.current || !snapshot) return
    fitAfterArrange.current = false
    fit()
  }, [snapshot])
  const inView = (p: Position) => {
    const v = viewport, extra = composer ? 260 : 70
    return (p.x + p.width) * v.zoom + v.x > -250 && p.x * v.zoom + v.x < size.width + 250
      && (p.y + p.height + extra) * v.zoom + v.y > -250 && p.y * v.zoom + v.y < size.height + 250
  }
  const visible = (snapshot?.nodes ?? []).filter(n => inView(n.position) || composer?.cardId === n.sessionId)
  const visibleNotes = (snapshot?.notes ?? []).filter(n => inView(n.position) || composer?.cardId === n.id || editingNotes.has(n.id))
  const readable = new Set([...visible].sort((a, b) => a.sessionId === focus ? -1 : b.sessionId === focus ? 1
    : Math.hypot(a.position.x * viewport.zoom + viewport.x - size.width / 2, a.position.y * viewport.zoom + viewport.y - size.height / 2)
    - Math.hypot(b.position.x * viewport.zoom + viewport.x - size.width / 2, b.position.y * viewport.zoom + viewport.y - size.height / 2)).slice(0, 8).map(n => n.sessionId))
  const positionsById = new Map([...(snapshot?.nodes.map(n => [n.sessionId, n.position] as const) ?? []), ...(snapshot?.notes.map(n => [n.id, n.position] as const) ?? [])])
  const titleOf = (id: string) => snapshot?.nodes.find(n => n.sessionId === id)?.title
    ?? (snapshot?.notes.some(n => n.id === id) ? 'Note' : undefined)
  const openComposer = (cardId: string, anchor?: Anchor, anchorKind?: Composer['anchorKind']) => {
    if (anchorKind !== 'selection') setSelection(null)
    setFocus(cardId)
    setComposer({ cardId, anchor, anchorKind: anchor ? anchorKind ?? 'answer' : undefined })
    const p = positionsById.get(cardId); if (!p) return
    // Keep the attached input above the canvas controls, including on shorter windows.
    const v = viewportRef.current, available = (stage.current?.clientHeight ?? size.height) - 95
    const zoom = Math.min(v.zoom, Math.max(.4, (available - 28) / (p.height + 190)))
    const bottom = (p.y + p.height + 190) * zoom + v.y
    if (bottom > available || zoom !== v.zoom) changeViewport({ zoom,
      x: (stage.current?.clientWidth ?? size.width) / 2 - (p.x + p.width / 2) * zoom,
      y: Math.min(v.y, available - (p.y + p.height + 190) * zoom) })
  }
  const previewFor = (sourceId: string) => (exclude: string[]): Promise<ContextPlan> => api.contextPreview(projectId, sourceId, exclude)
  const submitComposer = async (action: ComposerAction, text: string, operationId: string, exclude: string[], preset?: BranchPreset, anchor?: Anchor) => {
    if (!composer) return
    const source = composer, project = projectId
    const note = snapshot?.notes.find(n => n.id === source.cardId)
    const result = action === 'note'
      ? await api.note(project, operationId, text, source.cardId, anchor)
      : await api.start(project, operationId, text, note ? undefined : anchor, source.cardId, note?.id, exclude, preset)
    if (projectRef.current !== project) return
    const id = 'noteId' in result ? result.noteId : result.sessionId
    generation.current++
    revealAfterCreate.current = id; setComposer(null); await refresh(); setFocus(id)
  }
  const composerFor = (id: string) => composer && !composer.floating && composer.cardId === id ? composer : undefined
  const openSelectionComposer = (value: Selection) => {
    setSelection(value); setFocus(value.anchor.sessionId); showQuoteHighlight(value.range)
    const left = Math.max(12, Math.min(value.x, window.innerWidth - 468))
    const top = Math.max(56, Math.min(value.y, window.innerHeight - 330))
    setComposer({ cardId: value.anchor.sessionId, anchor: value.anchor, anchorKind: 'selection', floating: { left, top } })
  }
  const openReader = (id: string) => {
    closeComposer(); setSelection(null); setFocus(id)
    if (snapshot?.nodes.some(node => node.sessionId === id)) setReaderId(id)
    else { closeReader(); reveal(id) }
  }
  const submitReader = async (action: ComposerAction, text: string, operationId: string, exclude: string[], preset?: BranchPreset, anchor?: Anchor) => {
    const sourceId = readerId, project = projectId
    if (!sourceId) return
    if (action === 'ask') {
      await api.start(project, operationId, text, anchor, sourceId, undefined, exclude, preset)
      if (projectRef.current === project) { generation.current++; await refresh() }
    } else {
      const result = await api.note(project, operationId, text, sourceId, anchor)
      if (projectRef.current !== project) return
      generation.current++
      revealAfterCreate.current = result.noteId; closeReader(); await refresh(); setFocus(result.noteId)
    }
  }
  const confirmArchive = async () => {
    if (!archiveTarget) return
    const { sessionId } = archiveTarget, project = projectId
    await api.archive(project, sessionId)
    if (projectRef.current !== project) return
    generation.current++
    if (readerId === sessionId) closeReader()
    if (composer?.cardId === sessionId) closeComposer()
    if (selection?.anchor.sessionId === sessionId) { setSelection(null); clearQuoteHighlight() }
    if (highlight?.sessionId === sessionId) setHighlight(null)
    if (focus === sessionId) setFocus('')
    setSnapshot(current => current && ({ ...current,
      nodes: current.nodes.filter(node => node.sessionId !== sessionId),
      edges: current.edges.filter(edge => edge.sessionId !== sessionId && edge.anchor.sessionId !== sessionId),
      links: current.links.filter(link => link.fromId !== sessionId && link.toId !== sessionId),
      contextLinks: current.contextLinks.map(link => ({ ...link,
        ...(link.fromId === sessionId ? { missingFrom: true } : {}), ...(link.toId === sessionId ? { missingTo: true } : {}) })),
      pending: current.pending.filter(op => op.sessionId !== sessionId),
    }))
    setArchiveTarget(null)
    void refresh()
    void api.projects().then(setProjects).catch(() => {})
  }
  /** Drag from the consuming card's handle onto the card whose content should join this card's context. */
  const startLinkDrag = (event: import('react').PointerEvent, fromId: string) => {
    event.preventDefault(); event.stopPropagation()
    const bounds = stage.current?.getBoundingClientRect(); if (!bounds) return
    const position = positionsById.get(fromId); if (!position) return
    const v = viewportRef.current
    const anchorTo = (clientX: number, clientY: number) => {
      const world = { x: (clientX - bounds.left - v.x) / v.zoom, y: (clientY - bounds.top - v.y) / v.zoom }
      const anchor = edgeAnchor(position, world, 3)
      return { x: bounds.left + anchor.x * v.zoom + v.x, y: bounds.top + anchor.y * v.zoom + v.y }
    }
    const targetAt = (x: number, y: number) => {
      const card = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>('.pc-card')
      return card?.dataset.sessionId ?? card?.dataset.noteId
    }
    setLinkDrag({ fromId, from: anchorTo(event.clientX, event.clientY), to: { x: event.clientX, y: event.clientY }, targetId: targetAt(event.clientX, event.clientY) })
    const move = (e: PointerEvent) => setLinkDrag(current => current && ({ ...current, from: anchorTo(e.clientX, e.clientY),
      to: { x: e.clientX, y: e.clientY }, targetId: targetAt(e.clientX, e.clientY) }))
    const finish = async (e: PointerEvent) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish)
      const toId = targetAt(e.clientX, e.clientY)
      setLinkDrag(null)
      if (!toId || toId === fromId) return
      const selected = selectionRef.current
      const anchor = !e.shiftKey && selected?.anchor.sessionId === toId ? selected.anchor : undefined
      try { await api.link(projectId, fromId, toId, anchor); setSelection(null); await refresh() }
      catch (error) { setError(errorText(error)) }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
  }

  // Overlay coordinates are relative to the viewport, matching its own pan/zoom transform.
  const toScreen = (point: { x: number; y: number }) => ({ x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y })
  const cardHeight = (position: Position) => position.collapsed ? 48 : position.height
  const cardCenter = (position: Position) => ({ x: position.x + position.width / 2, y: position.y + cardHeight(position) / 2 })
  /** Boundary point of the card on the line toward `toward`, pushed out by `gap`. */
  const edgeAnchor = (position: Position, toward: { x: number; y: number }, gap: number) => {
    const center = cardCenter(position), height = cardHeight(position)
    const dx = toward.x - center.x, dy = toward.y - center.y
    if (!dx && !dy) return center
    const scale = Math.min(dx ? (position.width / 2) / Math.abs(dx) : Infinity, dy ? (height / 2) / Math.abs(dy) : Infinity)
    const length = Math.hypot(dx, dy)
    return { x: center.x + dx * scale + (dx / length) * gap, y: center.y + dy * scale + (dy / length) * gap }
  }
  const outward = (position: Position, point: { x: number; y: number }) => {
    const center = cardCenter(position)
    const dx = point.x - center.x, dy = point.y - center.y, length = Math.hypot(dx, dy) || 1
    return { x: dx / length, y: dy / length }
  }
  /** The eight fixed anchor points: four edge midpoints and four corners, pushed outward by `gap`. */
  const cardAnchors = (position: Position, gap: number) => {
    const height = cardHeight(position), x = position.x, y = position.y, width = position.width
    const raw = [
      { x: x + width / 2, y, nx: 0, ny: -1 }, { x: x + width / 2, y: y + height, nx: 0, ny: 1 },
      { x, y: y + height / 2, nx: -1, ny: 0 }, { x: x + width, y: y + height / 2, nx: 1, ny: 0 },
      { x, y, nx: -1, ny: -1 }, { x: x + width, y, nx: 1, ny: -1 },
      { x, y: y + height, nx: -1, ny: 1 }, { x: x + width, y: y + height, nx: 1, ny: 1 },
    ]
    return raw.map(anchor => {
      const length = Math.hypot(anchor.nx, anchor.ny) || 1
      return { x: anchor.x + (anchor.nx / length) * gap, y: anchor.y + (anchor.ny / length) * gap,
        nx: anchor.nx / length, ny: anchor.ny / length }
    })
  }
  const branchAnchors = (from: Position, to: Position) => {
    const starts = cardAnchors(from, 4), ends = cardAnchors(to, 7)
    let best = { start: starts[0]!, end: ends[0]!, distance: Infinity }
    for (const start of starts) for (const end of ends) {
      const distance = Math.hypot(end.x - start.x, end.y - start.y)
      if (distance < best.distance) best = { start, end, distance }
    }
    return best
  }
  /** Rebuild a readable hierarchy from branch/note edges, with unrelated cards in a grid. */
  const arrange = async () => {
    const state = snapshot
    if (!state || !projectId) return
    const cards = [
      ...state.nodes.map(node => ({ id: node.sessionId, position: node.position })),
      ...state.notes.map(note => ({ id: note.id, position: note.position })),
    ]
    if (!cards.length) return
    const byId = new Map(cards.map(card => [card.id, card]))
    const heightOf = (position: Position) => position.collapsed ? 48 : position.height
    const parent = new Map<string, string>()
    for (const link of state.links) {
      if (link.fromId === link.toId || !byId.has(link.fromId) || !byId.has(link.toId) || parent.has(link.toId)) continue
      parent.set(link.toId, link.fromId)
    }
    const children = new Map<string, string[]>(cards.map(card => [card.id, []]))
    for (const card of cards) { const owner = parent.get(card.id); if (owner) children.get(owner)!.push(card.id) }
    const roots = cards.filter(card => !parent.has(card.id)).map(card => card.id)
    const subtree = new Map<string, number>(), rowHeight: number[] = [], seen = new Set<string>()
    const measure = (id: string, depth: number): number => {
      if (seen.has(id)) return 0
      seen.add(id)
      const position = byId.get(id)!.position
      rowHeight[depth] = Math.max(rowHeight[depth] ?? 0, heightOf(position))
      let width = position.width
      const kids = (children.get(id) ?? []).filter(kid => !seen.has(kid))
      if (kids.length) {
        let sum = 0
        for (const kid of kids) sum += measure(kid, depth + 1) + ARRANGE_GAP_X
        width = Math.max(width, sum - ARRANGE_GAP_X)
      }
      subtree.set(id, width)
      return width
    }
    const orderedRoots: string[] = []
    for (const root of roots) if (!seen.has(root)) { orderedRoots.push(root); measure(root, 0) }
    for (const card of cards) if (!seen.has(card.id)) { orderedRoots.push(card.id); measure(card.id, 0) }
    const yOf: number[] = []; let cursorY = ARRANGE_ORIGIN
    for (let depth = 0; depth < rowHeight.length; depth++) { yOf[depth] = cursorY; cursorY += (rowHeight[depth] ?? 0) + ARRANGE_GAP_Y }
    const placed = new Map<string, { x: number; y: number }>()
    let cursorX = ARRANGE_ORIGIN
    const assign = (id: string, left: number, depth: number) => {
      const position = byId.get(id)!.position, width = subtree.get(id) ?? position.width
      placed.set(id, { x: Math.round(left + (width - position.width) / 2), y: Math.round(yOf[depth] ?? ARRANGE_ORIGIN) })
      let x = left
      for (const kid of children.get(id) ?? []) {
        if (placed.has(kid) || !subtree.has(kid)) continue
        assign(kid, x, depth + 1)
        x += (subtree.get(kid) ?? 0) + ARRANGE_GAP_X
      }
    }
    for (const root of orderedRoots) {
      assign(root, cursorX, 0)
      cursorX += (subtree.get(root) ?? byId.get(root)!.position.width) + ARRANGE_GAP_X
    }
    if (!parent.size) {
      const columns = Math.ceil(Math.sqrt(cards.length))
      let x = ARRANGE_ORIGIN, y = ARRANGE_ORIGIN, column = 0, rowMax = 0
      for (const card of [...cards].sort((a, b) => (a.position.x - b.position.x) || (a.position.y - b.position.y))) {
        placed.set(card.id, { x, y })
        rowMax = Math.max(rowMax, heightOf(card.position))
        column++
        x += ARRANGE_GRID_X
        if (column >= columns) { column = 0; x = ARRANGE_ORIGIN; y += rowMax + ARRANGE_GAP_Y; rowMax = 0 }
      }
    }
    try {
      await Promise.all([...placed].map(([id, point]) => {
        const position = byId.get(id)!.position
        return api.layout(projectId, { sessionId: id, position: { ...position, x: point.x, y: point.y } })
      }))
      fitAfterArrange.current = true
      await refresh()
    } catch (error) { setError(errorText(error)) }
  }

  return <CanvasFiles.Provider value={openFile ? previewFile : undefined}><section className="pc-root" aria-label="项目画布">
    <header className="pc-topbar">
      <button ref={projectToggleRef} className="pc-project-toggle" aria-expanded={projectsOpen} aria-haspopup="dialog"
        onClick={() => { setProjectsOpen(open => !open); setProjectError('') }}>
        <ProjectGlyph />
        <span className="pc-project-title">{projects.find(project => project.id === projectId)?.title ?? '选择项目'}</span>
        <ProjectCaret />
      </button>
      <div className="pc-topbar-spacer"/>
      <button disabled={!projectId} className="pc-primary" title="新建对话" onClick={() => { setSelection(null); setComposer(null); setDialog(true) }}>＋ 新建</button>
    </header>
    {projectsOpen && <aside ref={projectsRef} className="pc-projects" role="dialog" aria-label="选择项目">
      <header><span>项目</span><button aria-label="关闭项目面板" onClick={() => setProjectsOpen(false)}>×</button></header>
      <ul>{projects.map(project => <li key={project.id}>
        <button className={project.id === projectId ? 'pc-project-active' : ''} onClick={() => { pendingProject.current = ''; entryTarget.current = null; setProjectId(project.id); setProjectsOpen(false) }}>
          <span>{project.title}</span><small>{project.sessionCount} 个对话</small>
        </button>
      </li>)}{!projects.length && <li className="pc-projects-empty">还没有项目</li>}</ul>
      <button className="pc-project-add" disabled={projectBusy || !pickDirectory} aria-busy={projectBusy} onClick={() => void addProject()}>
        <span aria-hidden="true">＋</span>新增项目
      </button>
      {projectError && <p className="pc-projects-error" role="alert">{projectError}</p>}
    </aside>}
    {error && <div className="pc-error" role="alert">{error}<button onClick={() => void refresh()}>重试</button></div>}
    {!!snapshot?.pending.length && <div className="pc-pending">有 {snapshot.pending.length} 个提问尚未提交完成
      {snapshot.pending.map(op => <button key={op.id} onClick={() => void api.retry(projectId, op.id).then(() => refresh()).catch(e => setError(errorText(e)))}>继续：{op.question.slice(0, 24)}</button>)}</div>}
    <div ref={stage} className="pc-viewport" onPointerDown={pan} onPointerMove={pointerNear} onPointerLeave={() => { if (nearRef.current) { const element = document.querySelector<HTMLElement>(`[data-session-id="${nearRef.current}"],[data-note-id="${nearRef.current}"]`); element?.style.removeProperty('--pc-slime-x'); element?.style.removeProperty('--pc-slime-y'); element?.style.removeProperty('--pc-slime-proximity'); nearRef.current = '' } setNear('') }}
      style={{ backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`, backgroundPosition: `${viewport.x}px ${viewport.y}px` }}>
      {!projectId && <div className="pc-empty"><p>先在 DSH 里创建一个项目</p></div>}
      {projectId && snapshot?.nodes.length === 0 && snapshot.notes.length === 0 && <div className="pc-empty"><p>还没有对话</p></div>}
      {projectId && !snapshot && !error && <div className="pc-empty">正在打开…</div>}
    {!!(snapshot?.contextLinks ?? []).length && <svg className="pc-context-overlay" aria-hidden="true">
          <defs><marker id="pc-context-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker></defs>
          {(snapshot?.contextLinks ?? []).map(link => {
            if (link.missingFrom || link.missingTo) return null
            const a = positionsById.get(link.fromId), b = positionsById.get(link.toId)
            if (!a || !b) return null
            const startWorld = edgeAnchor(a, cardCenter(b), 4), endWorld = edgeAnchor(b, cardCenter(a), 9)
            const start = toScreen(startWorld), end = toScreen(endWorld)
            const outStart = outward(a, startWorld), outEnd = outward(b, endWorld)
            const distance = Math.hypot(end.x - start.x, end.y - start.y)
            const bend = Math.max(18, Math.min(80, distance * 0.28))
            const c1 = { x: start.x + outStart.x * bend, y: start.y + outStart.y * bend }
            const c2 = { x: end.x + outEnd.x * bend, y: end.y + outEnd.y * bend }
            const curve = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
            const mid = { x: (start.x + 3 * c1.x + 3 * c2.x + end.x) / 8, y: (start.y + 3 * c1.y + 3 * c2.y + end.y) / 8 }
            return <g key={link.id} className={`pc-context-link${hoverLink === link.id ? ' pc-context-link-hover' : ''}`}
              onPointerEnter={() => setHoverLink(link.id)} onPointerLeave={() => setHoverLink('')}>
              <path className="pc-link-hit" d={curve} />
              <path d={curve} markerEnd="url(#pc-context-arrow)" />
              {hoverLink === link.id && <g className="pc-link-del" onClick={() => void api.unlink(projectId, link.id).then(() => refresh()).catch(error => setError(errorText(error)))}>
                <circle cx={mid.x} cy={mid.y} r={10} />
                <text x={mid.x} y={mid.y + 4} textAnchor="middle">×</text>
              </g>}
            </g>
          })}
      </svg>}
      <div className="pc-world" style={{ transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})` }}>
        <svg className="pc-connections" aria-hidden="true">{snapshot?.links.map(link => {
          const a = positionsById.get(link.fromId), b = positionsById.get(link.toId)
          if (!a || !b) return null
          const { start, end } = branchAnchors(a, b)
          const distance = Math.hypot(end.x - start.x, end.y - start.y)
          const bend = Math.max(16, Math.min(80, distance * 0.22))
          const c1 = { x: start.x + start.nx * bend, y: start.y + start.ny * bend }
          const c2 = { x: end.x + end.nx * bend, y: end.y + end.ny * bend }
          return <path key={link.id} d={`M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`} />
        })}</svg>
        {visible.map(node => <SessionNode key={`${projectId}:${node.sessionId}`} api={api} workspaceId={projectId} node={node}
          zoom={viewport.zoom} focused={focus === node.sessionId} near={near === node.sessionId} readable={!readerId && readable.has(node.sessionId)}
          composer={composerFor(node.sessionId)}
          edge={snapshot?.edges.find(e => e.sessionId === node.sessionId)}
          highlightedSeq={highlight?.sessionId === node.sessionId ? highlight.seq : undefined}
          onFocus={() => setFocus(node.sessionId)} onReveal={reveal} onPosition={position => updatePosition(node.sessionId, position)}
          onPositionEnd={position => updatePosition(node.sessionId, position, true)}
          onSelect={openSelectionComposer}
          onCompose={anchor => openComposer(node.sessionId, anchor, 'answer')} onCloseCompose={closeComposer} onSubmitCompose={submitComposer}
          loadPreview={previewFor(node.sessionId)} onOpenSession={() => openReader(node.sessionId)}
          onArchive={() => setArchiveTarget({ sessionId: node.sessionId, title: node.title })}
          linkTarget={linkDrag?.targetId === node.sessionId} onLinkDrag={event => startLinkDrag(event, node.sessionId)} fresh={freshCardId === node.sessionId} />)}
        {visibleNotes.map(note => <NoteNode key={`${projectId}:${note.id}`} note={note} zoom={viewport.zoom} focused={focus === note.id}
          near={near === note.id} composer={composerFor(note.id)} sourceTitle={titleOf(note.parentId)}
          onFocus={() => setFocus(note.id)} onReveal={reveal} onPosition={position => updatePosition(note.id, position)}
          onPositionEnd={position => updatePosition(note.id, position, true)} onCompose={() => openComposer(note.id)}
          onCloseCompose={closeComposer} onSubmitCompose={submitComposer} loadPreview={previewFor(note.id)}
          onEditingChange={active => trackNoteEditing(note.id, active)}
          onSaveNote={async text => {
            const project = projectId
            await api.updateNote(project, note.id, text)
            if (projectRef.current !== project) return
            generation.current++
            setSnapshot(current => current && ({ ...current, notes: current.notes.map(item => item.id === note.id ? { ...item, text } : item) }))
            void refresh()
          }}
          linkTarget={linkDrag?.targetId === note.id} onLinkDrag={event => startLinkDrag(event, note.id)} fresh={freshCardId === note.id} />)}
      </div>
      <nav className="pc-tools" aria-label="画布视角"><button onClick={() => changeViewport({ ...viewport, zoom: limitZoom(viewport.zoom / 1.2) })} title="缩小">−</button>
        <span>{Math.round(viewport.zoom * 100)}%</span><button onClick={() => changeViewport({ ...viewport, zoom: limitZoom(viewport.zoom * 1.2) })} title="放大">＋</button>
        <i/><button onClick={() => void arrange()} title="按来源关系整理卡片位置">整理</button><button onClick={fit} title="适应全部">适应</button></nav>
    </div>
    {composer?.floating && <CardComposer open anchor={composer.anchor} floating={composer.floating}
      loadPreview={previewFor(composer.cardId)} onOpen={() => {}} onClose={closeComposer} onSubmit={submitComposer} />}
    {linkDrag && <svg className="pc-link-overlay" aria-hidden="true">
      <defs><marker id="pc-drag-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" />
      </marker></defs>
      <line x1={linkDrag.from.x} y1={linkDrag.from.y} x2={linkDrag.to.x} y2={linkDrag.to.y} markerEnd="url(#pc-drag-arrow)" />
      <circle cx={linkDrag.from.x} cy={linkDrag.from.y} r={4} />
    </svg>}
    {linkDrag?.targetId && <div className="pc-link-badge" style={{ left: linkDrag.to.x + 14, top: linkDrag.to.y + 14 }}>
      {selectionRef.current?.anchor.sessionId === linkDrag.targetId
        ? `引用选区 · ${selectionRef.current.anchor.quote.slice(0, 24)}` : '引用整卡'}
    </div>}
    {readerId && snapshot && <SessionReader api={api} workspaceId={projectId} snapshot={snapshot} sessionId={readerId} drafts={readerDrafts.current}
      onOpen={openReader} onClose={closeReader} onOpenNative={openSession} onSubmit={submitReader}/>}
    {dialog && <NativeStartDialog key={projectId} drafts={drafts} workspaceId={projectId} SessionProvider={SessionProvider} renderSlot={renderSlot}
      onClose={() => setDialog(false)} onCreated={async id => { generation.current++; revealAfterCreate.current = id; setDialog(false); await refresh(); setFocus(id) }} />}
    {archiveTarget && <ArchiveDialog key={`${projectId}:${archiveTarget.sessionId}`} title={archiveTarget.title}
      onClose={() => setArchiveTarget(null)} onConfirm={confirmArchive}/>}
    <NativeInteractions sessionIds={snapshot?.nodes.map(node => node.sessionId) ?? []} renderSlot={renderSlot}/>
  </section></CanvasFiles.Provider>
}
