import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ProjectCanvas, digest } from '../src/canvas.ts'
import type { CanvasSessions, CanvasTables } from '../src/canvas.ts'
import type { Anchor, CanvasState, Message, Operation } from '../src/model.ts'
import { ancestry, canvasSchema, emptyCanvas, operationSchema } from '../src/model.ts'
import { BRANCH_PRESETS, PRESET_IDS } from '../src/presets.ts'

function table<T>() {
  const data = new Map<string, T>()
  return { get: (id: string) => data.get(id), put: async (id: string, value: T) => { data.set(id, structuredClone(value)) }, entries: () => data.entries() }
}
function fixture() {
  const members = new Set(['source', 'unrelated']), archived = new Set<string>()
  const history = new Map<string, Message[]>([
    ['source', [{ seq: 1, role: 'user', text: '介绍模型', hash: digest('介绍模型') },
      { seq: 2, role: 'assistant', text: 'Transformer 通过注意力处理序列。', hash: digest('Transformer 通过注意力处理序列。') }]],
    ['unrelated', [{ seq: 1, role: 'user', text: '不可自动带入的另一段对话', hash: digest('不可自动带入的另一段对话') }]],
  ])
  const tables: CanvasTables = { canvases: table<CanvasState>(), operations: table<Operation>() }
  const calls: { id: string; text: string; request: string }[] = [], accepted = new Set<string>()
  let creates = 0, failAfterAdmission = false
  const sessions: CanvasSessions = {
    projects: () => [{ id: 'project', title: 'Project', path: '/project', sessionCount: [...members].filter(id => !archived.has(id)).length }],
    members: id => id === 'project' ? [...members].filter(id => !archived.has(id)) : [],
    summaries: async () => new Map([...members].map(id => [id, { title: id, running: false }])),
    messages: async id => history.get(id) ?? [],
    create: async (_project, id) => { if (!members.has(id)) { creates++; members.add(id); history.set(id, []) }; return id },
    prompt: async (id, text, request) => {
      if (!accepted.has(request)) { accepted.add(request); calls.push({ id, text, request }) }
      if (failAfterAdmission) { failAfterAdmission = false; throw new Error('断线发生在消息已接收之后') }
    },
    rename: async () => {}, cancel: async () => {},
    archive: async (workspaceId, id) => { if (workspaceId !== 'project' || !members.has(id)) throw new Error('对话不在当前项目中'); archived.add(id) },
  }
  const canvas = new ProjectCanvas(tables, sessions)
  const anchor: Anchor = { sessionId: 'source', seq: 2, quote: '注意力', messageHash: history.get('source')![1]!.hash }
  return { canvas, tables, sessions, members, archived, history, calls, anchor, creates: () => creates,
    failAfterAdmission: () => { failAfterAdmission = true } }
}
const signal = () => new AbortController().signal

test('preset badges survive persistence and renamed session titles; typed preset text stays custom', async () => {
  const f = fixture(), created = []
  for (const preset of PRESET_IDS) {
    const result = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: BRANCH_PRESETS[preset].question,
      preset, anchor: f.anchor }, signal())
    created.push({ ...result, preset })
  }
  const custom = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: BRANCH_PRESETS.explain.question, anchor: f.anchor }, signal())
  f.sessions.summaries = async () => new Map([...f.members].map(id => [id, { title: '后来重命名的标题', running: false }]))
  const restored = new ProjectCanvas(f.tables, f.sessions), view = await restored.snapshot('project', signal())
  for (const item of created) {
    const node = view.nodes.find(node => node.sessionId === item.sessionId)!
    assert.equal(node.preset, item.preset); assert.equal(node.title, '后来重命名的标题')
  }
  assert.equal(view.nodes.find(node => node.sessionId === custom.sessionId)!.preset, undefined)
})

test('retry keeps the selected preset identity after a lost acknowledgement', async () => {
  const f = fixture(), operationId = randomUUID(); f.failAfterAdmission()
  const input = { workspaceId: 'project', operationId, question: BRANCH_PRESETS.eli5.question, preset: 'eli5' as const, anchor: f.anchor }
  await assert.rejects(f.canvas.start(input, signal()), /断线/)
  const restored = new ProjectCanvas(f.tables, f.sessions)
  const result = await restored.retry('project', operationId, signal())
  assert.equal((await restored.snapshot('project', signal())).nodes.find(node => node.sessionId === result.sessionId)!.preset, 'eli5')
  assert.equal(f.creates(), 1); assert.equal(f.calls.length, 1)
  await assert.rejects(restored.start({ ...input, preset: 'deeper' }, signal()), /另一个提问/)
})

test('legacy quick branches retain retry compatibility and are identified by original question', async () => {
  const f = fixture(), operationId = randomUUID()
  const input = { workspaceId: 'project', operationId, question: BRANCH_PRESETS.deeper.question, anchor: f.anchor }
  const result = await f.canvas.start(input, signal())
  const { preset: _preset, ...legacy } = f.tables.operations.get(operationId)!
  await f.tables.operations.put(operationId, operationSchema.parse(legacy))
  const restored = new ProjectCanvas(f.tables, f.sessions)
  assert.equal((await restored.snapshot('project', signal())).nodes.find(node => node.sessionId === result.sessionId)!.preset, 'deeper')
  assert.deepEqual(await restored.start(input, signal()), result)
  assert.equal(f.creates(), 1)
})

test('archive hides only the chosen session and its edges, retaining logs and layout for restore', async () => {
  const f = fixture()
  const branch = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '解释', anchor: f.anchor }, signal())
  const before = await f.canvas.snapshot('project', signal()), saved = before.nodes.find(n => n.sessionId === 'source')!.position
  const history = structuredClone(f.history.get('source'))
  await f.canvas.archive('project', 'source', signal())
  const after = await f.canvas.snapshot('project', signal())
  assert.ok(!after.nodes.some(n => n.sessionId === 'source'))
  assert.ok(after.nodes.some(n => n.sessionId === branch.sessionId)); assert.ok(after.nodes.some(n => n.sessionId === 'unrelated'))
  assert.equal(after.edges.length, 0); assert.equal(after.links.length, 0)
  assert.deepEqual(f.history.get('source'), history); assert.equal(f.calls.length, 1)
  await f.canvas.archive('project', 'source', signal())
  f.archived.delete('source')
  const restored = await new ProjectCanvas(f.tables, f.sessions).snapshot('project', signal())
  assert.deepEqual(restored.nodes.find(n => n.sessionId === 'source')!.position, saved)
  assert.equal(restored.edges.length, 1)
})

test('archive rejects foreign sessions and aborted requests without archiving any session', async () => {
  const f = fixture()
  await assert.rejects(f.canvas.archive('project', 'foreign', signal()), /当前项目/)
  await assert.rejects(f.canvas.archive('foreign-project', 'source', signal()), /项目不存在/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(f.canvas.archive('project', 'source', abort.signal))
  assert.equal(f.archived.size, 0)
})

test('archiving a visible pending branch removes its retry notice without erasing provenance', async () => {
  const f = fixture(), operationId = randomUUID(); f.failAfterAdmission()
  await assert.rejects(f.canvas.start({ workspaceId: 'project', operationId, question: '解释', anchor: f.anchor }, signal()))
  const pending = (await f.canvas.snapshot('project', signal())).pending[0]!
  await f.canvas.archive('project', pending.sessionId, signal())
  assert.equal((await f.canvas.snapshot('project', signal())).pending.length, 0)
  assert.ok(f.tables.operations.get(operationId))
})

test('ordinary project conversations become disconnected cards without model calls', async () => {
  const f = fixture(), view = await f.canvas.snapshot('project', signal())
  assert.equal(view.nodes.length, 2); assert.deepEqual(view.edges, []); assert.equal(f.calls.length, 0)
  const saved = view.nodes.find(n => n.sessionId === 'source')!.position
  f.members.add('external-new-chat')
  const next = await f.canvas.snapshot('project', signal())
  assert.equal(next.nodes.length, 3); assert.deepEqual(next.nodes.find(n => n.sessionId === 'source')!.position, saved)
})
test('branch creates an independent session, carries chosen source, excludes unrelated history', async () => {
  const f = fixture(), operationId = randomUUID()
  const result = await f.canvas.start({ workspaceId: 'project', operationId, question: '注意力是什么？', anchor: f.anchor }, signal())
  assert.notEqual(result.sessionId, 'source'); assert.equal(f.creates(), 1)
  assert.match(f.calls[0]!.text, /注意力是什么？/); assert.match(f.calls[0]!.text, /介绍模型/)
  assert.match(f.calls[0]!.text, /Transformer/); assert.doesNotMatch(f.calls[0]!.text, /不可自动带入/)
  const view = await f.canvas.snapshot('project', signal())
  assert.equal(view.edges.length, 1); assert.equal(view.edges[0]!.anchor.sessionId, 'source')
  assert.equal(view.edges[0]!.sourceTitle, 'source')
})
test('lost acknowledgement and process restart retry exactly the same session and native prompt identity', async () => {
  const f = fixture(), operationId = randomUUID(); f.failAfterAdmission()
  await assert.rejects(f.canvas.start({ workspaceId: 'project', operationId, question: '解释', anchor: f.anchor }, signal()), /断线/)
  const restored = new ProjectCanvas(f.tables, f.sessions)
  const pending = (await restored.snapshot('project', signal())).pending
  assert.equal(pending.length, 1)
  await restored.retry('project', operationId, signal())
  assert.equal(f.creates(), 1); assert.equal(f.calls.length, 1)
  assert.equal((await restored.snapshot('project', signal())).pending.length, 0)
  await restored.retry('project', operationId, signal())
  assert.equal(f.creates(), 1); assert.equal(f.calls.length, 1)
})
test('concurrent duplicate branch submissions and reused operation ids cannot create duplicates', async () => {
  const f = fixture(), operationId = randomUUID(), input = { workspaceId: 'project', operationId, question: '解释', anchor: f.anchor }
  const [a, b] = await Promise.all([f.canvas.start(input, signal()), f.canvas.start(input, signal())])
  assert.equal(a.sessionId, b.sessionId); assert.equal(f.creates(), 1); assert.equal(f.calls.length, 1)
  await assert.rejects(f.canvas.start({ ...input, question: '不同问题' }, signal()), /另一个提问/)
})
test('context reads only allow ancestry and stop at the original source boundary', async () => {
  const f = fixture(), result = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '解释', anchor: f.anchor }, signal())
  f.history.get('source')!.push({ seq: 3, role: 'assistant', text: '父对话分支之后的新内容', hash: digest('父对话分支之后的新内容') })
  await assert.rejects(f.canvas.readContext(result.sessionId, 'unrelated', undefined, signal()), /来源链/)
  await assert.rejects(f.canvas.readContext(result.sessionId, 'source', 3, signal()), /晚于/)
  const content = await f.canvas.readContext(result.sessionId, 'source', 2, signal())
  assert.equal(content.messages[0]!.seq, 2); assert.doesNotMatch(JSON.stringify(content), /分支之后/)
})
test('changed or cross-project source is rejected before creating a new session', async () => {
  const f = fixture()
  await assert.rejects(f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '解释',
    anchor: { ...f.anchor, messageHash: '0'.repeat(64) } }, signal()), /来源回答已变化/)
  await assert.rejects(f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '解释',
    anchor: { ...f.anchor, sessionId: 'foreign' } }, signal()), /当前项目/)
  assert.equal(f.creates(), 0)
})
test('per-card layout patches preserve other cards and restored layouts', async () => {
  const f = fixture(); await f.canvas.snapshot('project', signal())
  const before = f.tables.canvases.get('project')!, other = before.nodes.unrelated
  const position = { ...before.nodes.source!, x: -120, y: 450 }
  await f.canvas.layout('project', { sessionId: 'source', position })
  const restored = await new ProjectCanvas(f.tables, f.sessions).snapshot('project', signal())
  assert.deepEqual(restored.nodes.find(n => n.sessionId === 'source')!.position, position)
  assert.deepEqual(restored.nodes.find(n => n.sessionId === 'unrelated')!.position, other)
})
test('cancelled submissions do not activate an agent and ancestry cycles terminate', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort()
  await assert.rejects(f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '解释' }, abort.signal))
  assert.equal(f.creates(), 0)
  assert.equal(ancestry('a', [{ sessionId: 'a', anchor: { ...f.anchor, sessionId: 'b' }, question: 'q' },
    { sessionId: 'b', anchor: { ...f.anchor, sessionId: 'a' }, question: 'q' }]).length, 1)
})

test('notes persist with links and geometry without creating a session or calling a model', async () => {
  const f = fixture(), operationId = randomUUID(), input = { workspaceId: 'project', operationId, text: '记住：注意力是按相关性取信息。', parentId: 'source', anchor: f.anchor }
  const note = await f.canvas.note(input, signal())
  assert.deepEqual(await f.canvas.note(input, signal()), note)
  assert.equal(f.calls.length, 0); assert.equal(f.creates(), 0)
  const restored = new ProjectCanvas(f.tables, f.sessions), view = await restored.snapshot('project', signal())
  assert.equal(view.notes.length, 1); assert.equal(view.nodes.length, 2)
  assert.equal(view.links[0]!.fromId, 'source'); assert.equal(view.links[0]!.toId, note.noteId)
  const position = { ...view.notes[0]!.position, x: -500, collapsed: true }
  await restored.layout('project', { sessionId: note.noteId, position })
  assert.deepEqual((await restored.snapshot('project', signal())).notes[0]!.position, position)
  await assert.rejects(restored.note({ ...input, text: '另一条笔记' }, signal()), /另一条笔记/)
})

test('asking from a note creates an independent session linked to the note with bounded source context', async () => {
  const f = fixture()
  const { noteId } = await f.canvas.note({ workspaceId: 'project', operationId: randomUUID(), parentId: 'source', text: '这是我的笔记内容', anchor: f.anchor }, signal())
  const result = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), noteId, parentId: noteId, question: '举个例子' }, signal())
  assert.equal(f.creates(), 1); assert.match(f.calls[0]!.text, /这是我的笔记内容/)
  assert.match(f.calls[0]!.text, /Transformer/); assert.doesNotMatch(f.calls[0]!.text, /不可自动带入/)
  const view = await f.canvas.snapshot('project', signal())
  assert.ok(view.links.some(link => link.fromId === noteId && link.toId === result.sessionId))
  assert.equal(view.edges[0]!.noteId, noteId)
  assert.equal(view.edges[0]!.sourceTitle, 'Note')
  assert.equal((await f.canvas.readContext(result.sessionId, 'source', 2, signal())).messages[0]!.seq, 2)
  await assert.rejects(f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), noteId: 'foreign-note', question: '解释' }, signal()), /笔记不在当前项目/)
})

test('notes reject foreign or mismatched sources and legacy canvases acquire an empty note collection', async () => {
  const f = fixture()
  await assert.rejects(f.canvas.note({ workspaceId: 'project', operationId: randomUUID(), text: '笔记', parentId: 'foreign' }, signal()), /当前项目/)
  await assert.rejects(f.canvas.note({ workspaceId: 'project', operationId: randomUUID(), text: '笔记', parentId: 'unrelated', anchor: f.anchor }, signal()), /不一致/)
  const { notes: _notes, ...legacy } = emptyCanvas('project')
  assert.deepEqual(canvasSchema.parse(legacy).notes, {})
  assert.equal(f.calls.length, 0); assert.equal(f.creates(), 0)
})

function addSession(f: ReturnType<typeof fixture>, id: string, question: string, answer: string) {
  f.members.add(id)
  f.history.set(id, [
    { seq: 1, role: 'user', text: question, hash: digest(question) },
    { seq: 2, role: 'assistant', text: answer, hash: digest(answer) },
  ])
}

test('context links are one-way, idempotent and validate endpoints and selections', async () => {
  const f = fixture()
  const link = await f.canvas.link({ workspaceId: 'project', fromId: 'source', toId: 'unrelated' }, signal())
  assert.equal(link.fromId, 'source'); assert.equal(link.toId, 'unrelated')
  assert.equal((await f.canvas.link({ workspaceId: 'project', fromId: 'source', toId: 'unrelated' }, signal())).id, link.id)
  await assert.rejects(f.canvas.link({ workspaceId: 'project', fromId: 'source', toId: 'source' }, signal()), /自身/)
  await assert.rejects(f.canvas.link({ workspaceId: 'project', fromId: 'source', toId: 'foreign' }, signal()), /不在当前项目/)
  await assert.rejects(f.canvas.link({ workspaceId: 'project', fromId: 'source', toId: 'unrelated', anchor: f.anchor }, signal()), /选区与链接目标不一致/)
  const view = await f.canvas.snapshot('project', signal())
  assert.equal(view.contextLinks.length, 1); assert.equal(view.contextLinks[0]!.id, link.id)
  await f.canvas.unlink('project', link.id)
  assert.equal((await f.canvas.snapshot('project', signal())).contextLinks.length, 0)
})

test('context-link closure is cycle-safe, depth-ordered and deduplicated', async () => {
  const f = fixture(); addSession(f, 'third', '第三个问题', '第三个对话的回答'); addSession(f, 'unrelated', '另一个问题', '另一个回答')
  await f.canvas.link({ workspaceId: 'project', fromId: 'source', toId: 'third' }, signal())
  await f.canvas.link({ workspaceId: 'project', fromId: 'third', toId: 'unrelated' }, signal())
  await f.canvas.link({ workspaceId: 'project', fromId: 'unrelated', toId: 'source' }, signal())
  const plan = await f.canvas.contextPreview('project', 'source', [], signal())
  assert.deepEqual(plan.items.map(item => [item.cardId, item.depth, item.path.length]), [['third', 1, 2], ['unrelated', 2, 3]])
  assert.match(plan.items[0]!.answer!, /第三个对话的回答/)
  assert.match(plan.items[1]!.answer!, /另一个回答/)
  assert.ok(plan.omitted.some(entry => entry.reason === 'duplicate' && entry.cardId === 'source'))
  const excluded = await f.canvas.contextPreview('project', 'source', ['third'], signal())
  assert.equal(excluded.items.length, 0)
  assert.ok(excluded.omitted.some(entry => entry.reason === 'excluded'))
})

test('a long context chain stays within the persisted path limit instead of failing an Ask', async () => {
  const f = fixture()
  let fromId = 'source'
  for (let n = 0; n < 40; n++) {
    const toId = `n${n}`; addSession(f, toId, 'q', 'a')
    await f.canvas.link({ workspaceId: 'project', fromId, toId }, signal())
    fromId = toId
  }
  const result = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '长链接', parentId: 'source' }, signal())
  const operation = [...f.tables.operations.entries()].map(([, op]) => op).find(op => op.sessionId === result.sessionId)!
  assert.ok(operationSchema.safeParse(operation).success)
  assert.ok(operation.linked.length > 0)
})

test('selection links carry the anchored excerpt and changed sources are omitted', async () => {
  const f = fixture(); addSession(f, 'third', '第三个问题', '第三个对话的回答')
  const thirdAnswer = f.history.get('third')![1]!
  await f.canvas.link({ workspaceId: 'project', fromId: 'source', toId: 'third',
    anchor: { sessionId: 'third', seq: 2, quote: '第三个', messageHash: thirdAnswer.hash } }, signal())
  const plan = await f.canvas.contextPreview('project', 'source', [], signal())
  assert.equal(plan.items[0]!.cardId, 'third'); assert.equal(plan.items[0]!.maxSeq, 2)
  assert.match(plan.items[0]!.question!, /第三个问题/); assert.match(plan.items[0]!.answer!, /第三个/)
  f.history.get('third')![1] = { ...thirdAnswer, text: '被改写的内容', hash: digest('被改写的内容') }
  const changed = await f.canvas.contextPreview('project', 'source', [], signal())
  assert.equal(changed.items.length, 0)
  assert.ok(changed.omitted.some(entry => entry.reason === 'changed'))
})

test('Ask from a card packages the linked closure and reads stay inside the captured position', async () => {
  const f = fixture(); addSession(f, 'third', '第三个问题', '第三个对话的回答')
  await f.canvas.link({ workspaceId: 'project', fromId: 'source', toId: 'third' }, signal())
  const result = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '结合链接解释', parentId: 'source' }, signal())
  assert.match(f.calls[0]!.text, /canvas_reference/); assert.match(f.calls[0]!.text, /第三个对话的回答/)
  const operation = [...f.tables.operations.entries()].map(([, op]) => op).find(op => op.sessionId === result.sessionId)!
  assert.equal(operation.linked[0]!.cardId, 'third'); assert.equal(operation.linked[0]!.maxSeq, 2)
  f.history.get('third')!.push({ seq: 3, role: 'assistant', text: '链接之后的新内容', hash: digest('链接之后的新内容') })
  const context = await f.canvas.readContext(result.sessionId, 'third', undefined, signal())
  assert.ok(context.messages.length > 0 && context.messages.every(message => message.seq <= 2))
  await assert.rejects(f.canvas.readContext(result.sessionId, 'unrelated', undefined, signal()), /只能读取/)
  await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '排除链接', parentId: 'source', exclude: ['third'] }, signal())
  assert.doesNotMatch(f.calls[1]!.text, /第三个对话的回答/)
})

test('quoting a branch uses the human question without copying its hidden context envelope', async () => {
  const f = fixture()
  const branch = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '这个机制的成本呢？', anchor: f.anchor }, signal())
  const prompt = f.calls[0]!.text
  f.history.set(branch.sessionId, [
    { seq: 1, role: 'user', text: prompt, hash: digest(prompt) },
    { seq: 2, role: 'assistant', text: '这里是对成本的回答。', hash: digest('这里是对成本的回答。') },
  ])
  await f.canvas.link({ workspaceId: 'project', fromId: 'unrelated', toId: branch.sessionId }, signal())
  const preview = await f.canvas.contextPreview('project', 'unrelated', [], signal())
  assert.equal(preview.items[0]!.question, '这个机制的成本呢？')
  assert.doesNotMatch(JSON.stringify(preview), /Transformer|canvas_reference/)
  const consumer = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '结合它解释', parentId: 'unrelated' }, signal())
  const context = await f.canvas.readContext(consumer.sessionId, branch.sessionId, 1, signal())
  assert.equal(context.messages[0]!.text, '这个机制的成本呢？')
  assert.doesNotMatch(JSON.stringify(context), /Transformer|canvas_reference/)
  assert.equal((await f.canvas.messages('project', branch.sessionId, signal())).messages[0]!.text, '这个机制的成本呢？')
  assert.equal(f.history.get(branch.sessionId)![0]!.text, prompt, 'native provenance remains untouched')
})

test('notes can be edited as markdown while keeping their source anchor', async () => {
  const f = fixture(), operationId = randomUUID()
  const { noteId } = await f.canvas.note({ workspaceId: 'project', operationId, parentId: 'source', text: '# 旧标题\n内容', anchor: f.anchor }, signal())
  await f.canvas.updateNote({ workspaceId: 'project', noteId, text: '# 新标题\n\n- 列表\n- **加粗**' }, signal())
  const view = await f.canvas.snapshot('project', signal())
  assert.equal(view.notes[0]!.text, '# 新标题\n\n- 列表\n- **加粗**')
  assert.deepEqual(view.notes[0]!.anchor, f.anchor)
  await assert.rejects(f.canvas.updateNote({ workspaceId: 'project', noteId: 'foreign', text: 'x' }, signal()), /笔记不在当前项目/)
})

test('native composer reserves one hidden draft per project and publishes only after acceptance', async () => {
  const f = fixture()
  f.members.add('ordinary-blank')
  f.sessions.summaries = async () => new Map([...f.members].map(id => [id, {
    title: id, running: false, blank: (f.history.get(id)?.length ?? 0) === 0,
  }]))
  const drafts = await Promise.all(Array.from({ length: 4 }, () => f.canvas.prepareDraft('project', signal())))
  assert.equal(new Set(drafts.map(draft => draft.sessionId)).size, 1)
  assert.equal(f.creates(), 1); assert.equal(f.calls.length, 0)
  const id = drafts[0].sessionId
  const before = await f.canvas.snapshot('project', signal())
  assert.ok(!before.nodes.some(node => node.sessionId === id))
  assert.ok(!before.nodes.some(node => node.sessionId === 'ordinary-blank'), 'native blank sessions stay off the canvas until they carry content')
  const restored = new ProjectCanvas(f.tables, f.sessions)
  assert.equal((await restored.prepareDraft('project', signal())).sessionId, id)
  f.history.set(id, [{ seq: 1, role: 'user', text: '附件问题', hash: digest('附件问题') }])
  const published = await restored.snapshot('project', signal())
  const position = published.nodes.find(node => node.sessionId === id)!.position
  assert.equal(published.edges.length, 0); assert.equal(published.links.length, 0)
  const next = await restored.prepareDraft('project', signal())
  assert.notEqual(next.sessionId, id)
  const after = await restored.snapshot('project', signal())
  assert.deepEqual(after.nodes.find(node => node.sessionId === id)?.position, position)
  assert.ok(!after.nodes.some(node => node.sessionId === next.sessionId))
  assert.equal(f.creates(), 2); assert.equal(f.calls.length, 0)
  assert.equal(canvasSchema.parse(f.tables.canvases.get('project')).draftSessionId, next.sessionId)
})

test('a native draft create with a lost reply recovers its reserved identity; unknown projects cannot create', async () => {
  const f = fixture(), create = f.sessions.create
  f.sessions.create = async (workspaceId, id) => { await create(workspaceId, id); throw new Error('连接中断') }
  await assert.rejects(f.canvas.prepareDraft('project', signal()), /连接中断/)
  const reserved = f.tables.canvases.get('project')!.draftSessionId
  f.sessions.create = create
  f.sessions.summaries = async () => new Map([...f.members].map(id => [id, { title: id, running: false, blank: id === reserved }]))
  const restored = new ProjectCanvas(f.tables, f.sessions)
  assert.equal((await restored.prepareDraft('project', signal())).sessionId, reserved)
  assert.equal(f.creates(), 1)
  await assert.rejects(restored.prepareDraft('other-project', signal()), /项目不存在/)
  assert.equal(f.creates(), 1)
})

test('displayed reasoning and process-only steps do not enter linked answer context', async () => {
  const f = fixture(), source = f.history.get('source')!
  source[1].reasoning = '这段仅用于折叠展示，不应自动带入分支。'
  for (let seq = 3; seq < 15; seq++) source.push({ seq, role: 'assistant', text: '', reasoning: '工具前的思考。', hash: digest('') })
  await f.canvas.link({ workspaceId: 'project', fromId: 'unrelated', toId: 'source' }, signal())
  const preview = await f.canvas.contextPreview('project', 'unrelated', [], signal())
  assert.equal(preview.items[0]?.answer, source[1].text)
  assert.equal(preview.items[0]?.maxSeq, 2)
  const branch = await f.canvas.start({ workspaceId: 'project', operationId: randomUUID(), question: '继续说明', anchor: f.anchor }, signal())
  assert.ok(!f.calls.at(-1)!.text.includes(source[1].reasoning))
  assert.ok(!(JSON.stringify(await f.canvas.readContext(branch.sessionId, 'source', undefined, signal()))).includes(source[1].reasoning))
})
