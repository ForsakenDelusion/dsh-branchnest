// Run against `npm run smoke -- --keep`; all questions use the local deterministic fixture.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const host = JSON.parse(await readFile(process.env.CANVAS_HOST_REPORT || new URL('../artifacts/smoke.json', import.meta.url), 'utf8'))
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const checks = [], errors = [], failures = [], created = []
let workspaceId
page.on('pageerror', error => errors.push(error.message))
async function rpc(endpoint, request, canvas = false) {
  const response = await page.request.post(`${host.origin}/api/${canvas ? 'project-canvas' : endpoint}`, {
    headers: { Origin: host.origin }, data: { type: 'client-request', rpcId: randomUUID(), method: canvas ? 'project-canvas' : endpoint,
      payload: canvas ? { endpoint, payload: request } : { args: { [endpoint === 'session/list' ? '_request' : 'request']: request } } } })
  assert.equal(response.status(), 200)
  const result = (await response.json()).result
  assert.ok(result?.ok, `${endpoint}: ${JSON.stringify(result?.error)}`)
  return result.value
}
async function until(work, message, timeout = 15000) {
  const end = Date.now() + timeout; let last
  while (Date.now() < end) { try { const result = await work(); if (result) return result } catch (error) { last = error } await page.waitForTimeout(150) }
  throw new Error(`${message}${last ? ': ' + last.message : ''}`)
}
async function check(name, work) {
  await work(); checks.push(name)
}
const question = () => page.getByText('在画布中选择一个答案', { exact: true })
const modal = () => page.locator('.pc-native-interactions')
const choose = () => modal().getByRole('radio', { name: /继续探索/ })
async function submit() {
  await choose().click()
  await modal().getByRole('button', { name: /提交|完成|发送/ }).last().click()
}
async function branch(parentId) {
  const { sessionId } = await rpc('start', { workspaceId, operationId: randomUUID(), question: 'CANVAS_QUESTION_CHECK', parentId }, true)
  created.push(sessionId)
  return sessionId
}
try {
  await page.goto(host.launchUrl)
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click({ timeout: 5000 }).catch(() => {})
  const directory = path.join(host.home, `questions-ui-${randomUUID().slice(0, 8)}`)
  await mkdir(directory)
  workspaceId = (await rpc('createProject', { path: directory }, true)).id
  const { sessionId } = await rpc('session/create', { workspaceId }); created.push(sessionId)
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '原生问答验证的来源对话' }] })
  await until(async () => !(await rpc('messages', { workspaceId, sessionId }, true)).running, 'fixture source answer')
  const title = `问答回归 ${sessionId.slice(-6)}`
  await rpc('session/rename', { sessionId, title })
  await page.reload()
  await page.getByRole('button', { name: /^(继续|Continue)$/ }).click({ timeout: 2000 }).catch(() => {})
  const nativeProject = page.locator(`[data-row-key="workspace:${workspaceId}"]`)
  await nativeProject.waitFor()
  if (await nativeProject.getAttribute('aria-expanded') === 'false') await nativeProject.click()
  await page.getByText(title, { exact: true }).first().click()
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'CANVAS_QUESTION_CHECK' }] })
  await check('real native ask_user_question appears before entering canvas', async () => {
    await question().waitFor({ state: 'visible', timeout: 15000 })
  })
  await page.getByRole('button', { name: '分支探索', exact: true }).click()
  await page.locator('.pc-root').waitFor()
  await check('pending native question follows the session onto its project canvas', async () => {
    await modal().waitFor({ state: 'visible', timeout: 10000 })
    await question().waitFor({ state: 'visible' })
    await page.screenshot({ path: new URL('../artifacts/questions-canvas.png', import.meta.url).pathname })
  })
  await check('canvas answer submits through the native question controller', async () => {
    await submit(); await modal().waitFor({ state: 'hidden', timeout: 10000 })
    await until(async () => !(await rpc('messages', { workspaceId, sessionId }, true)).running, 'answer did not resume and finish the native turn')
  })
  await page.locator(`.pc-card[data-session-id="${sessionId}"]`).getByRole('button', { name: '展开阅读', exact: true }).click()
  await page.locator('.pc-reader').waitFor()
  const first = await branch(sessionId)
  await check('an unopened background branch can ask a question above the full-screen reader', async () => {
    await modal().waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await page.locator('.pc-reader').count(), 1)
    assert.equal(await modal().evaluate(element => !!element.closest('[inert]')), false, 'reader must not inert the native modal portal')
    await choose().click()
    assert.equal(await choose().getAttribute('aria-checked'), 'true')
    await page.screenshot({ path: new URL('../artifacts/questions-reader.png', import.meta.url).pathname })
  })
  const second = await branch(sessionId)
  await check('multiple pending sessions stay selectable without resetting the current answer', async () => {
    const select = modal().getByRole('combobox', { name: '待处理会话' })
    await select.waitFor({ state: 'visible', timeout: 15000 })
    await until(async () => (await select.locator('option').count()) === 2, 'both question sessions must be listed')
    assert.ok((await select.inputValue()).startsWith(`${first}:`), 'new background requests must preserve the selected session')
    assert.equal(await choose().getAttribute('aria-checked'), 'true', 'new references must not remount the active question draft')
    await select.selectOption((await select.locator('option').evaluateAll(options => options.map(option => option.value))).find(value => value.startsWith(`${second}:`)))
    await submit()
    await until(async () => !(await rpc('messages', { workspaceId, sessionId: second }, true)).running, 'second question answer')
    await choose().waitFor()
    assert.equal(await choose().getAttribute('aria-checked'), 'true', 'switching sessions preserves the first question draft')
    await submit(); await modal().waitFor({ state: 'hidden', timeout: 10000 })
    await until(async () => !(await rpc('messages', { workspaceId, sessionId: first }, true)).running, 'first question answer')
  })
  await check('question modals do not leave an extra native composer or browser exception', async () => {
    assert.equal(await modal().count(), 0)
    assert.equal(await page.locator('.pc-root [data-composer-seat]').count(), 0)
    assert.deepEqual(errors, [])
  })
} catch (error) {
  failures.push({ name: 'Native interactions UI scenario', error: error.message.split('\n').slice(0, 5).join('\n') })
  await page.screenshot({ path: new URL('../artifacts/questions-ui-failure.png', import.meta.url).pathname }).catch(() => {})
} finally {
  for (const sessionId of created) await rpc('cancel', { workspaceId, sessionId }, true).catch(() => {})
  await browser.close()
  const result = { checks, failures, errors }
  await writeFile(new URL('../artifacts/questions-ui-smoke.json', import.meta.url), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
if (failures.length || errors.length) process.exitCode = 1
