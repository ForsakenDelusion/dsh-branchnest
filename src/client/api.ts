import type { Anchor, ContextLink, ContextPlan, Message, Position, Project, Snapshot, Viewport } from '../model.ts'
import type { BranchPreset } from '../presets.ts'

export interface Transcript { messages: Message[]; hasMore: boolean; running: boolean; error: string | null }
export interface CanvasApi {
  prepareDraft(workspaceId: string): Promise<{ sessionId: string }>
  projects(signal?: AbortSignal): Promise<Project[]>
  createProject(path: string): Promise<Project>
  snapshot(workspaceId: string, signal?: AbortSignal): Promise<Snapshot>
  layout(workspaceId: string, patch: { sessionId?: string; position?: Position; viewport?: Viewport }): Promise<void>
  messages(workspaceId: string, sessionId: string, signal?: AbortSignal, beforeSeq?: number): Promise<Transcript>
  start(workspaceId: string, operationId: string, question: string, anchor?: Anchor, parentId?: string, noteId?: string, exclude?: string[], preset?: BranchPreset): Promise<{ sessionId: string }>
  link(workspaceId: string, fromId: string, toId: string, anchor?: Anchor): Promise<{ link: ContextLink }>
  unlink(workspaceId: string, linkId: string): Promise<void>
  contextPreview(workspaceId: string, sourceId: string, exclude?: string[]): Promise<ContextPlan>
  note(workspaceId: string, operationId: string, text: string, parentId: string, anchor?: Anchor): Promise<{ noteId: string }>
  updateNote(workspaceId: string, noteId: string, text: string): Promise<void>
  retry(workspaceId: string, operationId: string): Promise<{ sessionId: string }>
  send(workspaceId: string, sessionId: string, text: string, requestId: string): Promise<void>
  cancel(workspaceId: string, sessionId: string): Promise<void>
  archive(workspaceId: string, sessionId: string): Promise<void>
}
export interface Selection { anchor: Anchor; title: string; x: number; y: number; range?: Range }
export interface Composer { cardId: string; anchor?: Anchor; anchorKind?: 'answer' | 'selection'; floating?: { left: number; top: number } }
