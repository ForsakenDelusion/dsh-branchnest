import { useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsRenderFactories, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { projectCanvasInteraction: true }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'project-canvas.interactions': {
      kind: 'single'; scope: 'root'; owner: { sessionIds: readonly string[] }
    }
    'project-canvas.interaction': { kind: 'single'; scope: 'session' }
  }
}

export type NativeInteractionsSlots = PropsRenderSlots<'project-canvas.interactions'>

const NoTranscript = () => null

/** The native Factory owns the composer chain, including its business-owned takeovers. */
function NativeInteractionSeat({ renderFactorySlot }: PropsRuntime<'project-canvas.interaction'> & PropsRenderFactories) {
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
    slots: { views: NoTranscript },
  })
}

type InteractionHostProps = PropsRuntime<'project-canvas.interactions'> & PropsRenderSlots<'project-canvas.interaction'> & {
  retain(sessionId: SessionId): SessionReference
  refreshProjections(sessionId: SessionId): Promise<void>
}

/** The canvas polls transcripts itself, so running sessions need their native UI scopes retained too. */
function NativeInteractionHost({ sessionIds, useSessions, useSessionStatus, SessionProvider, renderSlot, retain, refreshProjections }: InteractionHostProps) {
  const list = useSessions(value => value), statuses = useSessionStatus(value => value)
  const references = useRef(new Map<string, SessionReference>())
  const inspected = useRef(new Set<string>())
  const [, setRevision] = useState(0), [error, setError] = useState('')
  const identity = [...sessionIds].sort().join('\n')
  useEffect(() => {
    const ids = new Set(identity ? identity.split('\n') : [])
    for (const [id, reference] of references.current) {
      if (!ids.has(id)) { reference.release(); references.current.delete(id); inspected.current.delete(id) }
    }
    for (const id of ids) {
      const sessionId = id as SessionId, row = list.byId[sessionId]
      if (!row) continue
      // Opening every old transcript is unnecessary. A projection read can discover
      // questions that continued while the canvas was closed, without opening history.
      if (!inspected.current.has(id)) {
        inspected.current.add(id)
        void refreshProjections(sessionId).catch(() => { inspected.current.delete(id) })
      }
      const questions = (row.projectionValues as Record<string, unknown> | undefined)?.userQuestions
      const hasQuestions = typeof questions === 'object' && questions !== null
        && Array.isArray((questions as { active?: unknown }).active) && (questions as { active: unknown[] }).active.length > 0
      if (references.current.has(id) || (!row.running && !hasQuestions && !statuses.get(sessionId)?.pendingInteraction)) continue
      try {
        const reference = retain(sessionId)
        references.current.set(id, reference)
        void reference.ready.then(() => { if (references.current.get(id) === reference) setRevision(value => value + 1) }, reason => {
          if (references.current.get(id) !== reference) return
          references.current.delete(id); reference.release()
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    }
    // Keep an acquired scope until leaving this project: stopping and publishing
    // a continued question arrive separately, and releasing between them loses its seat.
  }, [identity, list, statuses, retain, refreshProjections])
  useEffect(() => () => {
    for (const reference of references.current.values()) reference.release()
    references.current.clear()
  }, [])
  const pending = sessionIds.flatMap(id => {
    const interaction = statuses.get(id as SessionId)?.pendingInteraction
    return interaction ? [interaction] : []
  })
  const [selectedKey, setSelectedKey] = useState('')
  const selected = pending.find(value => `${value.sessionId}:${value.key}` === selectedKey) ?? pending[0]
  const selectedIdentity = selected ? `${selected.sessionId}:${selected.key}` : ''
  useEffect(() => { setSelectedKey(selectedIdentity) }, [selectedIdentity])
  const reference = selected && references.current.get(selected.sessionId)
  // Modal uses the native body portal, above the reader's inert canvas siblings.
  // Closing a question is owned by its native entry; backdrop clicks preserve it.
  return selected && reference ? <Modal open headless title="会话需要你的回答" className="pc-native-interactions" onClose={() => {}}>
    <div className="pc-native-interaction-heading">
      <span>{list.byId[selected.sessionId]?.displayTitle ?? '会话需要你的回答'}</span>
      {pending.length > 1 && <select aria-label="待处理会话" value={selectedIdentity} onChange={event => setSelectedKey(event.target.value)}>
        {pending.map(value => <option key={`${value.sessionId}:${value.key}`} value={`${value.sessionId}:${value.key}`}>{list.byId[value.sessionId]?.displayTitle ?? value.sessionId}</option>)}
      </select>}
    </div>
    <div data-conversation-content data-content-phase="active" key={selected.sessionId}>
      <SessionProvider session={reference}>{renderSlot('project-canvas.interaction', {})}</SessionProvider>
    </div>
  </Modal> : error ? <div className="pc-native-interaction-error" role="alert">原生交互加载失败：{error}</div> : null
}

export function registerNativeInteractions(ctx: Context): void {
  ctx.slots.inject('project-canvas.interactions', () => ctx.slots.register({
    name: 'project-canvas.interactions', children: { 'project-canvas.interaction': { kind: 'single', scope: 'session' } },
    inject: () => ({ retain: (id: SessionId) => ctx.sessions.retain(id, { source: 'projectCanvasInteraction' }),
      refreshProjections: (id: SessionId) => ctx.sessions.refreshProjections(id) }),
  }, NativeInteractionHost))
  ctx.slots.inject('project-canvas.interaction', () => ctx.slots.register({
    name: 'project-canvas.interaction',
  }, NativeInteractionSeat))
}

export function NativeInteractions({ sessionIds, renderSlot }: NativeInteractionsSlots & { sessionIds: readonly string[] }) {
  return renderSlot('project-canvas.interactions', { sessionIds })
}
