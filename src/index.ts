import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'
import { LiveTranscript, projectSessionMessages } from './transcript.ts'
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-client-connection'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import { ProjectCanvas } from './canvas.ts'
import type { CanvasSessions } from './canvas.ts'
import { anchorSchema, canvasSchema, idSchema, operationSchema, positionSchema, presetSchema, viewportSchema } from './model.ts'

export const name = 'project-canvas'
export const inject = ['connection', 'webServer', 'workspaceRegistry', 'sessionController', 'sessionQuery', 'storageDomain', 'agents', 'tools']
// rc.3 exposes its pinned Zod 4.4.3 class in this API. Storage consumes only
// schema.parse/safeParse; keep our patched validator without comparing the
// recursive class types of two Zod releases or overriding the host's packages.
function storageTable<T>(schema: z.ZodType<T>): DomainTableSpec<string, T> {
  return domainTable(schema as unknown as DomainTableSpec<string, T>['valueSchema'])
}
const spec = defineDomain({ name: 'project_canvas', version: 1,
  tables: { canvases: storageTable(canvasSchema), operations: storageTable(operationSchema) } })
const workspaceRequest = z.object({ workspaceId: idSchema })
const createProjectRequest = z.object({ path: z.string().trim().min(1).max(4096) })
const sessionRequest = workspaceRequest.extend({ sessionId: idSchema })
const archiveRequest = sessionRequest.extend({ confirmed: z.literal(true) })
const startRequest = workspaceRequest.extend({ operationId: z.string().uuid(), question: z.string().trim().min(1).max(12000), anchor: anchorSchema.optional(), parentId: idSchema.optional(), noteId: idSchema.optional(), exclude: z.array(idSchema).max(64).optional(), preset: presetSchema.optional() })
const linkRequest = workspaceRequest.extend({ fromId: idSchema, toId: idSchema, anchor: anchorSchema.optional() })
const unlinkRequest = workspaceRequest.extend({ linkId: idSchema })
const previewRequest = workspaceRequest.extend({ sourceId: idSchema, exclude: z.array(idSchema).max(64).optional() })
const updateNoteRequest = workspaceRequest.extend({ noteId: idSchema, text: z.string().trim().min(1).max(12000) })
const noteRequest = workspaceRequest.extend({ operationId: z.string().uuid(), text: z.string().trim().min(1).max(12000), parentId: idSchema, anchor: anchorSchema.optional() })
const readRequest = sessionRequest.extend({ beforeSeq: z.number().int().nonnegative().optional() })
const layoutRequest = workspaceRequest.extend({ sessionId: idSchema.optional(), position: positionSchema.optional(), viewport: viewportSchema.optional() })
const retryRequest = workspaceRequest.extend({ operationId: z.string().uuid() })
const sendRequest = sessionRequest.extend({ text: z.string().trim().min(1).max(32000), requestId: z.string().uuid() })
const contextRequest = z.object({ session_id: idSchema, seq: z.number().int().nonnegative().optional() })
const asSessionId = (id: string) => id as SessionId

export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(spec)
  const live = new LiveTranscript()
  const errors = new Map<string, string>()
  const archived = (id: string) => ctx.workspaceRegistry.archivedSessionIds.includes(asSessionId(id))
  const adapter: CanvasSessions = {
    projects: (blank = new Set<string>()) => ctx.workspaceRegistry.list().map(p => ({ id: p.id, title: p.title, path: p.path,
      sessionCount: p.sessionIds.filter(id => !archived(id) && !blank.has(id)).length })),
    members: id => ctx.workspaceRegistry.list().find(p => p.id === id)?.sessionIds.filter(id => !archived(id)) ?? [],
    summaries: async signal => {
      const result = await ctx.sessionController.list({}, signal)
      return new Map(result.items.map(item => {
        const title = item.projections?.values.title
        return [item.sessionId, { title: typeof title === 'string' ? title : '新对话', running: item.running, blank: item.blank }]
      }))
    },
    messages: async (sessionId, signal) => {
      const observed = await ctx.sessionQuery.observeSession(asSessionId(sessionId), { signal })
      try {
        const attachments = ctx.get('attachments') as { fileHostPath(ref: unknown): string | undefined } | undefined
        const messages = projectSessionMessages(observed.events, extractSessionEventText, ref => {
          try { return attachments?.fileHostPath(ref) } catch { return undefined }
        })
        const pending = live.get(sessionId)
        if (pending) messages.push(pending)
        return messages
      } finally { observed[Symbol.dispose]() }
    },
    create: async (workspaceId, sessionId) => {
      // A crash may have created the reserved id before recording the next operation phase.
      let exists = false
      try { const source = await ctx.sessionQuery.observeSession(asSessionId(sessionId)); source[Symbol.dispose](); exists = true }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
      if (exists) {
        const project = ctx.workspaceRegistry.list().find(p => p.id === workspaceId)
        if (!project) throw new Error('项目已被移除')
        await project.attachSession(asSessionId(sessionId)); return sessionId
      }
      const project = ctx.workspaceRegistry.list().find(p => p.id === workspaceId)
      if (!project) throw new Error('项目已被移除')
      return (await ctx.sessionController.create({ workspaceId: project.id, sessionId: asSessionId(sessionId) })).sessionId
    },
    prompt: async (sessionId, text, requestId, signal) => {
      errors.delete(sessionId)
      await ctx.sessionController.prompt({ sessionId: asSessionId(sessionId), requestId: requestId as SessionRequestId,
        mode: 'queue', content: [{ type: 'text', text }] }, signal)
    },
    rename: async (sessionId, title) => { await ctx.sessionController.rename({ sessionId: asSessionId(sessionId), title }) },
    cancel: async sessionId => { await ctx.sessionController.cancel({ sessionId: asSessionId(sessionId) }) },
    archive: async (workspaceId, sessionId) => {
      const project = ctx.workspaceRegistry.list().find(p => p.id === workspaceId)
      if (!project?.sessionIds.includes(asSessionId(sessionId))) throw new Error('对话不在当前项目中')
      await ctx.workspaceRegistry.archiveSession(asSessionId(sessionId), { stopActivity: true })
    },
  }
  const canvas = new ProjectCanvas({ canvases: domain.table('canvases'), operations: domain.table('operations') }, adapter)
  ctx.effect(() => async () => { await canvas.drain(); await domain.close() }, 'project-canvas: persistence')
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    live.accept(agent.id, frame)
  })
  ctx.on('agent/error', ({ agent, error }) => { errors.set(agent.id, String(error)); live.delete(agent.id) })
  ctx.on('agent/disposed', ({ agent }) => { live.delete(agent.id); errors.delete(agent.id) })

  const dispatch = async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<unknown>> => {
    try {
      signal.throwIfAborted(); let value: unknown
      switch (endpoint) {
        case 'projects': {
          // Blank placeholders stay off the canvas, so they must not inflate 个对话.
          const listed = await ctx.sessionController.list({}, signal)
          value = canvas.projects(new Set(listed.items.filter(item => item.blank).map(item => item.sessionId)))
          break
        }
        case 'createProject': {
          const p = createProjectRequest.parse(payload)
          const project = await ctx.workspaceRegistry.create(p.path)
          value = { id: project.id, title: project.title, path: project.path,
            sessionCount: project.sessionIds.filter(id => !archived(id)).length }
          break
        }
        case 'snapshot': { const p = workspaceRequest.parse(payload); value = await canvas.snapshot(p.workspaceId, signal); break }
        case 'layout': { const p = layoutRequest.parse(payload); await canvas.layout(p.workspaceId, p); value = { saved: true }; break }
        case 'messages': { const p = readRequest.parse(payload); value = { ...await canvas.messages(p.workspaceId, p.sessionId, signal, p.beforeSeq),
          running: ctx.agents.get(asSessionId(p.sessionId))?.status === 'running', error: errors.get(p.sessionId) ?? null }; break }
        case 'prepareDraft': value = await canvas.prepareDraft(workspaceRequest.parse(payload).workspaceId, signal); break
        case 'start': value = await canvas.start(startRequest.parse(payload), signal); break
        case 'note': value = await canvas.note(noteRequest.parse(payload), signal); break
        case 'retry': { const p = retryRequest.parse(payload); value = await canvas.retry(p.workspaceId, p.operationId, signal); break }
        case 'send': { const p = sendRequest.parse(payload); await canvas.send(p.workspaceId, p.sessionId, p.text, p.requestId, signal); value = { accepted: true }; break }
        case 'cancel': { const p = sessionRequest.parse(payload); await canvas.cancel(p.workspaceId, p.sessionId); value = { cancelled: true }; break }
        case 'archive': { const p = archiveRequest.parse(payload); await canvas.archive(p.workspaceId, p.sessionId, signal); value = { archived: true }; break }
        case 'link': { const p = linkRequest.parse(payload); value = { link: await canvas.link(p, signal) }; break }
        case 'updateNote': { const p = updateNoteRequest.parse(payload); await canvas.updateNote(p, signal); value = { saved: true }; break }
        case 'unlink': { const p = unlinkRequest.parse(payload); await canvas.unlink(p.workspaceId, p.linkId); value = { removed: true }; break }
        case 'contextPreview': { const p = previewRequest.parse(payload); value = await canvas.contextPreview(p.workspaceId, p.sourceId, p.exclude ?? [], signal); break }
        default: throw new Error('未知的画布操作')
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: { code: signal.aborted ? 'project-canvas/cancelled' : 'project-canvas/failed',
        message: error instanceof z.ZodError ? '请求数据无效' : error instanceof Error ? error.message : String(error), details: {} } }
    }
  }
  // The shared channel serves Web and Desktop and restricts exact routes to owner Peers.
  // rc.2's generic rpc.handle captures a scope without webServer; use the supported Fetch registry.
  ctx.connection.fetch.register({ path: '/api/project-canvas', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let body
      try { body = clientRequestSchema.parse(await request.json()) }
      catch { return new Response('invalid RPC envelope', { status: 400 }) }
      const payload = z.object({ endpoint: z.string(), payload: z.unknown() }).safeParse(body.payload)
      if (body.method !== 'project-canvas' || !payload.success) return new Response('invalid canvas request', { status: 400 })
      const result = await dispatch(payload.data.endpoint, payload.data.payload, request.signal)
      return Response.json({ type: 'server-response', rpcId: body.rpcId, result })
    },
  })
  const installContextTool = (agent: Agent) => {
    if (!canvas.hasContext(agent.id)) return
    ctx.effect(() => agent.ctx.tools.register({ name: 'read_canvas_context',
    description: 'Read messages from the current canvas branch ancestry or from the cards linked into this Ask, up to the position captured when the Ask was assembled. Does not read sibling or unrelated conversations.',
    parameters: { type: 'object', properties: { session_id: { type: 'string', description: 'source.sessionId or a linked cardId with kind=session from canvas_reference' },
      seq: { type: 'integer', description: 'Optional exact source message seq' } }, required: ['session_id'], additionalProperties: false },
    output: { schema: { type: 'object', properties: { sessionId: { type: 'string' }, messages: { type: 'array', items: { type: 'object',
      properties: { seq: { type: 'integer' }, role: { type: 'string' }, text: { type: 'string' }, truncated: { type: 'boolean' } },
      required: ['seq', 'role', 'text', 'truncated'], additionalProperties: false } } }, required: ['sessionId', 'messages'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      if (!exec.agent) throw new Error('来源读取需要当前 Agent 身份')
      const p = contextRequest.parse(args); return canvas.readContext(exec.agent.id, p.session_id, p.seq, exec.signal)
    },
    }), 'project-canvas: branch context tool')
  }
  ctx.on('agent/created', ({ agent }) => { installContextTool(agent); return undefined })
  for (const agent of ctx.agents.list()) installContextTool(agent)
}
