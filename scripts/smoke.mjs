// Real DSH boot + native controllers + local fixture model, in a disposable DSH_HOME.
import { mkdtemp, mkdir, readFile, writeFile, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { BRANCH_PRESETS, PRESET_IDS } from '../src/presets.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const cli = process.env.DSH_CLI || (process.platform === 'darwin'
  ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' : 'dsh')
const home = await mkdtemp(path.join(tmpdir(), 'dsh-canvas-smoke-'))
const env = { ...process.env, DSH_HOME: home, CANVAS_FIXTURE_LOG: path.join(home, 'model-calls.jsonl') }
const run = args => execFileSync(cli, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const report = { dshVersion: run(['--version']).trim(), home, checks: [] }
run(['--profile', 'canvas-test', '--from-default-profile', 'web', '--dump-config'])
run(['plugin', '--profile', 'canvas-test', 'add', process.env.CANVAS_PACKAGE || root])
const patch = path.join(home, 'fixture.patch.yml')
await writeFile(patch, `- id: agent-default-model\n  config:\n    provider: canvas-fixture\n    model: fixture\n- insert:\n    - id: canvas-test-model\n      name: ${JSON.stringify(path.join(root, 'test/fixtures/model.mjs'))}\n    - id: canvas-test-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: canvas_fixture\n        transport: stdio\n        command: ${JSON.stringify(process.execPath)}\n        args: [${JSON.stringify(path.join(root, 'test/fixtures/mcp.mjs'))}]\n        env:\n          CANVAS_MCP_LOG: ${JSON.stringify(path.join(home, 'mcp-calls.jsonl'))}\n`)
const logFile = path.join(home, 'runtime.log'), log = await open(logFile, 'w')
const child = spawn(cli, ['--profile', 'canvas-test', '--patch', patch, '--no-open', '--port', '0'], { env, stdio: ['ignore', log.fd, log.fd] })
let cookie = '', origin = '', launchUrl = ''
async function waitFor(work, label, timeout = 30000) {
  const until = Date.now() + timeout; let last
  while (Date.now() < until) {
    try { const result = await work(); if (result) return result } catch (error) { last = error }
    if (child.exitCode !== null) throw new Error(`DSH exited ${child.exitCode}: ${(await readFile(logFile, 'utf8')).replace(/token=[^\s]+/g, 'token=[redacted]')}`)
    await setTimeout(150)
  }
  throw new Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`)
}
async function rpc(channel, endpoint, payload) {
  const response = await fetch(`${origin}${channel}/${endpoint}`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method: endpoint, payload }) })
  if (!response.ok) throw new Error(`${channel}/${endpoint}: HTTP ${response.status} ${(await response.text()).slice(0, 400)}`)
  const result = (await response.json()).result
  if (!result?.ok) throw new Error(`${endpoint}: ${JSON.stringify(result?.error)}`)
  return result.value
}
const native = (endpoint, request) => rpc('/api', endpoint, { args: { [endpoint === 'session/list' ? '_request' : 'request']: request } })
const canvas = (endpoint, request = {}) => rpc('/api', 'project-canvas', { endpoint, payload: request })
try {
  launchUrl = await waitFor(async () => (await readFile(logFile, 'utf8')).match(/dsh web: (http[^\s]+)/)?.[1], 'web boot')
  origin = new URL(launchUrl).origin
  const login = await fetch(launchUrl, { redirect: 'manual' })
  cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  assert.ok(cookie, 'launch link exchanges for an authenticated browser cookie')
  await waitFor(() => canvas('projects'), 'plugin activation')
  report.checks.push('Desktop bundled CLI boots the installed native bundle and RPC')
  const unauth = await fetch(`${origin}/api/project-canvas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(unauth.status, 401); report.checks.push('unauthenticated RPC refused')
  const crossOrigin = await fetch(`${origin}/api/project-canvas`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://example.invalid' }, body: JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method: 'project-canvas', payload: { endpoint: 'projects', payload: {} } }) })
  assert.equal(crossOrigin.status, 403); report.checks.push('authenticated cross-origin RPC refused')
  const directory = path.join(home, 'project'); await mkdir(directory)
  const created = await canvas('createProject', { path: directory })
  assert.equal(created.title, 'project'); assert.equal(created.sessionCount, 0)
  assert.ok((await canvas('projects')).some(project => project.id === created.id))
  report.checks.push('canvas adopts an existing host directory as a project with no native setup')
  const { workspace } = await native('workspace/create', { path: directory })
  assert.equal(workspace.workspaceId, created.id)
  const workspaceId = workspace.workspaceId
  const { sessionId: blankId } = await native('session/create', { workspaceId })
  const blankView = await canvas('snapshot', { workspaceId })
  assert.ok(!blankView.nodes.some(node => node.sessionId === blankId))
  assert.equal((await canvas('projects')).find(project => project.id === workspaceId)?.sessionCount, 0)
  report.checks.push('native blank placeholders stay off the canvas and out of project counts')
  const { sessionId: sourceId } = await native('session/create', { workspaceId })
  await native('session/rename', { sessionId: sourceId, title: 'Transformer：从基础开始' })
  await native('session/prompt', { sessionId: sourceId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '解释 Transformer 和注意力机制。' }] })
  const source = await waitFor(async () => { const m = await canvas('messages', { workspaceId, sessionId: sourceId }); return !m.running && m.messages.some(m => m.role === 'assistant' && !m.live) ? m : null }, 'fixture answer')
  const { sessionId: otherId } = await native('session/create', { workspaceId })
  await native('session/rename', { sessionId: otherId, title: '另一个独立的项目对话' })
  await native('session/prompt', { sessionId: otherId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '另一个独立的问题。' }] })
  await waitFor(async () => { const m = await canvas('messages', { workspaceId, sessionId: otherId }); return !m.running && m.messages.some(message => message.role === 'assistant' && !message.live) ? m : null }, 'independent answer')
  const baseline = await canvas('snapshot', { workspaceId })
  assert.equal(baseline.nodes.length, 2); assert.equal(baseline.edges.length, 0)
  const callsBefore = (await readFile(env.CANVAS_FIXTURE_LOG, 'utf8')).trim().split('\n').length
  await canvas('snapshot', { workspaceId })
  assert.equal((await readFile(env.CANVAS_FIXTURE_LOG, 'utf8')).trim().split('\n').length, callsBefore)
  report.checks.push('ordinary native sessions sync to disconnected cards; browsing makes no model requests')
  const answer = source.messages.find(m => m.role === 'assistant' && !m.live)
  const operationId = randomUUID(), anchor = { sessionId: sourceId, seq: answer.seq, quote: '注意力机制', messageHash: answer.hash }
  const branchInput = { workspaceId, operationId, question: '注意力机制为什么有效？', anchor }
  const branch = await canvas('start', branchInput)
  await waitFor(async () => { const m = await canvas('messages', { workspaceId, sessionId: branch.sessionId }); return !m.running && m.messages.some(m => m.role === 'assistant' && !m.live) ? m : null }, 'branch answer')
  const after = await canvas('snapshot', { workspaceId })
  assert.equal(after.nodes.length, 3); assert.equal(after.edges.length, 1)
  assert.equal(after.edges[0].anchor.sessionId, sourceId)
  assert.equal((await canvas('start', branchInput)).sessionId, branch.sessionId)
  assert.equal((await canvas('snapshot', { workspaceId })).nodes.length, 3)
  report.checks.push('branch creates a new ordinary session with source anchor and native answer; retries are idempotent')
  const original = after.nodes.find(n => n.sessionId === sourceId).position
  const position = { ...original, x: original.x + 40, y: original.y + 75 }
  await canvas('layout', { workspaceId, sessionId: sourceId, position })
  assert.deepEqual((await canvas('snapshot', { workspaceId })).nodes.find(n => n.sessionId === sourceId).position, position)
  report.checks.push('layout writes round-trip through DSH storageDomain')
  const countBeforeNote = (await readFile(env.CANVAS_FIXTURE_LOG, 'utf8')).trim().split('\n').length
  const noteInput = { workspaceId, operationId: randomUUID(), parentId: sourceId, anchor, text: '注意力：根据相关性，从上下文中取出需要的信息。' }
  const note = await canvas('note', noteInput)
  assert.deepEqual(await canvas('note', noteInput), note)
  const noted = await canvas('snapshot', { workspaceId })
  assert.equal(noted.notes.length, 1); assert.equal(noted.nodes.length, 3)
  assert.ok(noted.links.some(link => link.fromId === sourceId && link.toId === note.noteId))
  assert.equal((await readFile(env.CANVAS_FIXTURE_LOG, 'utf8')).trim().split('\n').length, countBeforeNote)
  const noteBranch = await canvas('start', { workspaceId, operationId: randomUUID(), parentId: note.noteId, noteId: note.noteId, question: '用一个生活中的例子说明这条笔记。' })
  await waitFor(async () => { const m = await canvas('messages', { workspaceId, sessionId: noteBranch.sessionId }); return !m.running && m.messages.some(m => m.role === 'assistant' && !m.live) ? m : null }, 'note branch answer')
  const final = await canvas('snapshot', { workspaceId })
  assert.ok(final.links.some(link => link.fromId === note.noteId && link.toId === noteBranch.sessionId))
  const calls = (await readFile(env.CANVAS_FIXTURE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.match(JSON.stringify(calls.at(-1)), /注意力：根据相关性/)
  await canvas('updateNote', { workspaceId, noteId: note.noteId, text: `${noteInput.text}\n\n**Markdown 加粗**` })
  const updatedNote = (await canvas('snapshot', { workspaceId })).notes.find(item => item.id === note.noteId)
  assert.match(updatedNote.text, /\*\*Markdown 加粗\*\*/)
  assert.ok(updatedNote.anchor)
  report.checks.push('Note persists without model/session creation; Ask from Note creates an anchored native branch; notes edit as markdown')

  const whole = await canvas('link', { workspaceId, fromId: sourceId, toId: branch.sessionId })
  assert.equal((await canvas('link', { workspaceId, fromId: sourceId, toId: branch.sessionId })).link.id, whole.link.id)
  const back = await canvas('link', { workspaceId, fromId: branch.sessionId, toId: sourceId })
  const preview = await canvas('contextPreview', { workspaceId, sourceId })
  assert.equal(preview.items.length, 1); assert.equal(preview.items[0].cardId, branch.sessionId); assert.equal(preview.items[0].depth, 1)
  assert.ok(preview.omitted.some(entry => entry.reason === 'duplicate'))
  assert.equal((await canvas('contextPreview', { workspaceId, sourceId, exclude: [branch.sessionId] })).items.length, 0)
  await canvas('unlink', { workspaceId, linkId: whole.link.id })
  await canvas('unlink', { workspaceId, linkId: back.link.id })
  const branchMessages = await canvas('messages', { workspaceId, sessionId: branch.sessionId })
  const branchAnswer = branchMessages.messages.find(m => m.role === 'assistant' && !m.live)
  const selectionLink = await canvas('link', { workspaceId, fromId: sourceId, toId: branch.sessionId,
    anchor: { sessionId: branch.sessionId, seq: branchAnswer.seq, quote: '注意力机制', messageHash: branchAnswer.hash } })
  const selectionPreview = await canvas('contextPreview', { workspaceId, sourceId })
  assert.equal(selectionPreview.items[0].maxSeq, branchAnswer.seq)
  assert.match(selectionPreview.items[0].answer, /注意力机制/)
  const linkedAsk = await canvas('start', { workspaceId, operationId: randomUUID(), question: '结合链接回答', parentId: sourceId })
  await waitFor(async () => { const m = await canvas('messages', { workspaceId, sessionId: linkedAsk.sessionId }); return !m.running && m.messages.some(m => m.role === 'assistant' && !m.live) ? m : null }, 'linked ask answer')
  const linkedCalls = (await readFile(env.CANVAS_FIXTURE_LOG, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.match(JSON.stringify(linkedCalls.at(-1)), /深入理解注意力机制/)
  assert.match(JSON.stringify(linkedCalls.at(-1)), /canvas_reference/)
  await canvas('unlink', { workspaceId, linkId: selectionLink.link.id })
  report.checks.push('context links: idempotent one-way links, cycle-safe closure preview, exclusions and selection anchors')
  await assert.rejects(canvas('archive', { workspaceId, sessionId: sourceId }), /请求数据无效/)
  assert.ok((await canvas('snapshot', { workspaceId })).nodes.some(node => node.sessionId === sourceId))
  await canvas('archive', { workspaceId, sessionId: sourceId, confirmed: true })
  await canvas('archive', { workspaceId, sessionId: sourceId, confirmed: true })
  const archivedView = await canvas('snapshot', { workspaceId })
  assert.ok(!archivedView.nodes.some(node => node.sessionId === sourceId))
  assert.ok(archivedView.nodes.some(node => node.sessionId === branch.sessionId))
  assert.ok(!archivedView.links.some(link => link.fromId === sourceId || link.toId === sourceId))
  await native('workspace/unarchiveSession', { sessionId: sourceId })
  const restored = await canvas('snapshot', { workspaceId })
  assert.deepEqual(restored.nodes.find(node => node.sessionId === sourceId).position, position)
  assert.ok((await canvas('messages', { workspaceId, sessionId: sourceId })).messages.some(message => message.hash === answer.hash))
  const { sessionId: activeId } = await native('session/create', { workspaceId })
  await native('session/prompt', { sessionId: activeId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '测试正在生成的对话归档。' }] })
  await waitFor(async () => (await canvas('messages', { workspaceId, sessionId: activeId })).running, 'active session before archive')
  await canvas('archive', { workspaceId, sessionId: activeId, confirmed: true })
  await waitFor(async () => !(await native('session/list', {})).items.find(item => item.sessionId === activeId)?.running, 'archived turn stops')
  assert.ok(!(await canvas('snapshot', { workspaceId })).nodes.some(node => node.sessionId === activeId))
  report.checks.push('archive requires confirmation, is idempotent, stops active work; native restore preserves history and canvas layout')
  const presetTitles = { explain: '注意力如何分配权重？', eli5: '用小朋友能懂的例子理解', deeper: '再深入看看注意力的计算' }
  const presetIds = {}
  await assert.rejects(canvas('start', { workspaceId, operationId: randomUUID(), question: 'invalid', parentId: sourceId, preset: 'unknown' }), /请求数据无效/)
  for (const preset of PRESET_IDS) {
    const input = { workspaceId, operationId: randomUUID(), question: BRANCH_PRESETS[preset].question, anchor, parentId: sourceId, preset }
    const tagged = await canvas('start', input)
    await waitFor(async () => { const m = await canvas('messages', { workspaceId, sessionId: tagged.sessionId }); return !m.running && m.messages.some(message => message.role === 'assistant' && !message.live) }, 'preset branch answer')
    await native('session/rename', { sessionId: tagged.sessionId, title: presetTitles[preset] })
    const view = await canvas('snapshot', { workspaceId })
    assert.equal(view.nodes.find(node => node.sessionId === tagged.sessionId).preset, preset)
    assert.equal((await canvas('start', input)).sessionId, tagged.sessionId)
    presetIds[preset] = tagged.sessionId
  }
  report.checks.push('Explain/ELI5/Go deeper metadata persists independently of native titles, validates inputs and survives retries')
  const beforeDraft = await canvas('snapshot', { workspaceId })
  const nativeDrafts = await Promise.all([canvas('prepareDraft', { workspaceId }), canvas('prepareDraft', { workspaceId })])
  const draftId = nativeDrafts[0].sessionId
  assert.equal(nativeDrafts[1].sessionId, draftId)
  assert.equal((await canvas('snapshot', { workspaceId })).nodes.length, beforeDraft.nodes.length)
  assert.ok((await native('session/list', {})).items.find(item => item.sessionId === draftId)?.blank)
  await native('session/prompt', { sessionId: draftId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'CANVAS_MCP_CHECK' }] })
  await waitFor(async () => { const m = await canvas('messages', { workspaceId, sessionId: draftId }); return !m.running && m.messages.some(message => message.role === 'assistant' && !message.live) }, 'native draft prompt and MCP result')
  await waitFor(async () => (await readFile(path.join(home, 'mcp-calls.jsonl'), 'utf8')).includes('echo'), 'real local MCP tool call')
  assert.ok((await canvas('snapshot', { workspaceId })).nodes.some(node => node.sessionId === draftId))
  assert.ok(!(await canvas('snapshot', { workspaceId })).links.some(link => link.fromId === draftId || link.toId === draftId))
  const nextDraft = await canvas('prepareDraft', { workspaceId })
  assert.notEqual(nextDraft.sessionId, draftId)
  assert.equal((await canvas('snapshot', { workspaceId })).nodes.length, beforeDraft.nodes.length + 1)
  report.checks.push('native composer draft is reused and hidden until sent; accepted root keeps project isolation and executes a real local stdio MCP tool')
  const toolMessages = (await canvas('messages', { workspaceId, sessionId: draftId })).messages
  assert.ok(toolMessages.some(message => message.tools?.some(tool => tool.name === 'mcp__canvas_fixture__echo')))
  assert.ok(toolMessages.every(message => !message.text.includes('mcp__canvas_fixture__echo {}')))
  const { sessionId: reasoningId } = await native('session/create', { workspaceId })
  await native('session/rename', { sessionId: reasoningId, title: '思考与回答' })
  await native('session/prompt', { sessionId: reasoningId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '请检查思考过程折叠，并给出回答。' }] })
  await waitFor(async () => (await canvas('messages', { workspaceId, sessionId: reasoningId })).messages.some(message => message.live && message.reasoningLive && message.reasoning && !message.text), 'live native reasoning before answer')
  const reasoningAnswer = await waitFor(async () => { const result = await canvas('messages', { workspaceId, sessionId: reasoningId }); return !result.running && result.messages.find(message => !message.live && message.reasoning && message.text) }, 'durable native reasoning and answer')
  assert.ok(reasoningAnswer.reasoning.includes('核对步骤')); assert.ok(!reasoningAnswer.text.includes('核对步骤'))
  report.checks.push('native live and durable reasoning render separately from answers; tool-call arguments stay out of answer prose')
  const runtime = await readFile(logFile, 'utf8')
  assert.doesNotMatch(runtime, /branchnest \(dsh-branchnest\): Error/)
  await mkdir(path.join(root, 'artifacts'), { recursive: true })
  await writeFile(path.join(root, 'artifacts/smoke.json'), JSON.stringify({ ...report, origin, workspaceId, sourceId, branchId: branch.sessionId, noteId: note.noteId, otherId, presetIds, reasoningId, toolSessionId: draftId, pid: child.pid, launchUrl }, null, 2))
  console.log(JSON.stringify({ ...report, origin, workspaceId }, null, 2))
  if (process.argv.includes('--keep')) {
    console.log('Kept test host running; local launch URL and PID are in artifacts/smoke.json')
    await new Promise(resolve => child.once('exit', resolve))
  }
} catch (error) {
  console.error(error.message)
  console.error((await readFile(logFile, 'utf8')).replace(/token=[^\s]+/g, 'token=[redacted]').slice(-7000))
  process.exitCode = 1
} finally {
  if (!process.argv.includes('--keep') || process.exitCode) child.kill('SIGTERM')
  await log.close().catch(() => {})
}
