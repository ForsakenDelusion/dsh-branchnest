// Run after `npm run smoke -- --keep`; this uses only the disposable fixture host.
// PLAYWRIGHT_MODULE may name an existing Playwright installation.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const host = JSON.parse(await readFile(new URL('../artifacts/smoke.json', import.meta.url), 'utf8'))
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const checks = [], failures = [], errors = []
const redact = text => text.replace(/token=[^\s\"'<>]+/g, 'token=<REDACTED>')
page.on('pageerror', error => errors.push(redact(error.message)))
const reportPath = new URL('../artifacts/ui-smoke.json', import.meta.url)
async function check(name, work) { try { await work(); checks.push(name) } catch (error) { failures.push({ name, error: redact(error.message).split('\n').slice(0, 12).join('\n') }) } }
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
async function openNativeSession(workspaceId, title) {
  const project = page.locator(`[data-row-key="workspace:${workspaceId}"]`)
  if (!await project.isVisible()) await page.getByRole('button', { name: /^(打开侧边栏|Open sidebar)$/ }).first().click()
  await project.waitFor()
  if ((await project.getAttribute('aria-expanded')) === 'false') await project.click()
  await page.getByText(title, { exact: true }).first().click()
  await until(async () => await page.locator('.pc-root').count() === 0, 'native sidebar session did not leave canvas')
}
try {
  await page.goto(host.launchUrl)
  await page.getByRole('button', { name: '分支探索', exact: true }).waitFor()
  const preview = page.getByRole('button', { name: 'Continue', exact: true })
  await preview.click({ timeout: 5000 }).catch(() => {})
  const directory = path.join(host.home, 'navigation-qa-project')
  await mkdir(directory, { recursive: true })
  await rpc('createProject', { path: directory }, true)
  const projects = await rpc('projects', {}, true)
  const project = projects.find(item => item.id !== projects[0].id)
  assert.ok(project, 'entry regression requires two projects')
  const { sessionId } = await rpc('session/create', { workspaceId: project.id })
  const title = `NAV QA 原会话 ${sessionId.slice(-6)}`
  await rpc('session/rename', { sessionId, title })
  await rpc('session/prompt', { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '导航回归测试' }] })
  await until(async () => !(await rpc('messages', { workspaceId: project.id, sessionId }, true)).running, 'fixture answer')
  await rpc('session/rename', { sessionId, title })
  const snapshot = await rpc('snapshot', { workspaceId: project.id }, true)
  const node = snapshot.nodes.find(item => item.sessionId === sessionId)
  await rpc('layout', { workspaceId: project.id, sessionId, position: { ...node.position, x: 10000, y: 10000 }, viewport: { x: 0, y: 0, zoom: .85 } }, true)
  const otherProject = projects.find(item => item.id !== project.id)
  const { sessionId: otherSessionId } = await rpc('session/create', { workspaceId: otherProject.id })
  const otherTitle = `NAV QA 另一项目 ${otherSessionId.slice(-6)}`
  await rpc('session/prompt', { sessionId: otherSessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: '另一项目导航回归测试' }] })
  await until(async () => !(await rpc('messages', { workspaceId: otherProject.id, sessionId: otherSessionId }, true)).running, 'other fixture answer')
  await rpc('session/rename', { sessionId: otherSessionId, title: otherTitle })
  await page.reload()
  await preview.click({ timeout: 5000 }).catch(() => {})
  const nativeProject = page.locator(`[data-row-key="workspace:${project.id}"]`)
  await nativeProject.waitFor()
  if ((await nativeProject.getAttribute('aria-expanded')) === 'false') await nativeProject.click()
  await page.getByText(title, { exact: true }).first().click()
  await page.getByRole('button', { name: '分支探索', exact: true }).click()
  await page.locator('.pc-project-title').waitFor()
  await check('canvas opens the current native session workspace and focuses its card', async () => {
    await until(async () => (await page.locator('.pc-project-title').innerText()) === project.title, 'canvas did not follow native workspace', 3500)
    await until(async () => await page.locator(`.pc-card.pc-focused[data-session-id="${sessionId}"]`).count(), 'current session card was not focused', 3500)
    const bounds = await page.locator(`.pc-card[data-session-id="${sessionId}"]`).boundingBox()
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1440 && bounds.y + bounds.height <= 1000, 'entry must reveal a card that was outside the saved viewport')
  })
  // Select explicitly so the native reader assertion still runs on a broken entry path.
  if ((await page.locator('.pc-project-title').innerText()) !== project.title) {
    await page.locator('.pc-project-toggle').click()
    await page.locator('.pc-projects').getByText(project.title, { exact: true }).click()
  }
  const card = page.locator(`.pc-card[data-session-id="${sessionId}"]`)
  if (!checks.includes('canvas opens the current native session workspace and focuses its card')) {
    await rpc('layout', { workspaceId: project.id, sessionId, position: { ...node.position, x: 40, y: 40 } }, true)
    await until(async () => {
      await page.getByRole('button', { name: '适应', exact: true }).click()
      return await card.count()
    }, 'recover target card for reader regression')
  }
  await card.waitFor()
  await card.getByRole('button', { name: '展开阅读', exact: true }).click()
  await page.locator('.pc-reader').waitFor()
  await check('reader uses one animated accessible branch toggle in its header', async () => {
    const header = page.locator('.pc-reader-header')
    const toggle = header.locator('button[aria-controls]')
    assert.equal(await toggle.count(), 1)
    assert.equal(await page.getByRole('button', { name: /[收起展开]+分支列表$/ }).count(), 1)
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    const branches = page.locator('.pc-reader-branches')
    const transition = await page.locator('.pc-reader-layout').evaluate(element => getComputedStyle(element).transitionDuration)
    assert.ok(transition.split(',').some(value => parseFloat(value) > 0), 'branch width transition is animated')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await branches.getAttribute('aria-hidden'), 'true')
    assert.equal(await branches.evaluate(element => element.inert), true)
    await until(async () => (await branches.evaluate(element => getComputedStyle(element).visibility)) === 'hidden', 'collapsed branch list stays visible')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(await branches.evaluate(element => element.inert), false)
    await until(async () => (await branches.evaluate(element => getComputedStyle(element).opacity)) === '1', 'expanded branch list did not finish opening')
  })
  await check('reader drag region has no overlapping hidden canvas controls', async () => {
    const regions = await page.locator('.pc-reader-header').evaluate(header => {
      const ancestors = []
      for (let element = header.parentElement; element; element = element.parentElement) ancestors.push(getComputedStyle(element).getPropertyValue('-webkit-app-region'))
      return { header: getComputedStyle(header).getPropertyValue('-webkit-app-region'), ancestors,
        controls: [...header.querySelectorAll('button')].map(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
        canvasHeader: getComputedStyle(document.querySelector('.pc-topbar')).visibility,
        body: getComputedStyle(document.querySelector('.pc-reader-layout')).getPropertyValue('-webkit-app-region') }
    })
    assert.equal(regions.header, 'drag')
    assert.ok(regions.ancestors.every(value => value !== 'no-drag'), 'an ancestor cancels the reader drag region')
    assert.ok(regions.controls.every(value => value === 'no-drag'))
    assert.equal(regions.canvasHeader, 'hidden')
    assert.equal(regions.body, 'no-drag')
  })
  await page.screenshot({ path: new URL('../artifacts/reader-ui.png', import.meta.url).pathname })
  await check('reader opens the original native DSH session without the legacy floating dock', async () => {
    const nativeButton = page.getByRole('button', { name: '在 DSH 中打开', exact: true })
    if (await nativeButton.count()) await nativeButton.click()
    else await page.getByRole('button', { name: '继续对话', exact: true }).click()
    assert.equal(await page.locator('.pc-dock').count(), 0, 'legacy floating conversation dock still opens')
    await until(async () => await page.locator('.pc-root').count() === 0, 'native conversation did not open', 3500)
    await until(async () => (await page.locator(`[data-row-key="session:${sessionId}"]`).getAttribute('aria-selected')) === 'true', 'the native conversation must retain the original session identity', 3500)
  })
  await check('canvas topbar keeps the new-session action without a return button', async () => {
    if (await page.locator('.pc-root').count() === 0) await page.getByRole('button', { name: '分支探索', exact: true }).click()
    const reader = page.locator('.pc-reader')
    if (await reader.count()) await reader.getByRole('button', { name: '返回画布', exact: true }).click()
    assert.equal(await page.locator('.pc-topbar').getByRole('button', { name: '返回 DSH 对话', exact: true }).count(), 0)
    assert.equal(await page.locator('.pc-topbar').getByRole('button', { name: '＋ 新建', exact: true }).count(), 1)
  })
  await check('manual project choice survives the five-second project refresh', async () => {
    if (await page.locator('.pc-root').count() === 0) await page.getByRole('button', { name: '分支探索', exact: true }).click()
    await page.locator('.pc-project-title').waitFor()
    const other = projects.find(item => item.id !== project.id)
    await page.locator('.pc-project-toggle').click()
    await page.locator('.pc-projects').getByText(other.title, { exact: true }).click()
    await page.waitForTimeout(5500) // Exercise the real five-second refresh interval.
    assert.equal(await page.locator('.pc-project-title').innerText(), other.title)
    await openNativeSession(project.id, title)
    await page.getByRole('button', { name: '分支探索', exact: true }).click()
    await until(async () => (await page.locator('.pc-project-title').innerText()) === project.title, 're-entry must follow the unchanged native session again')
  })
  await check('re-entering from a different native session follows its workspace', async () => {
    await openNativeSession(otherProject.id, otherTitle)
    await page.getByRole('button', { name: '分支探索', exact: true }).click()
    await until(async () => (await page.locator('.pc-project-title').innerText()) === otherProject.title, 'canvas failed to follow the newly selected native session')
    await until(async () => await page.locator(`.pc-card.pc-focused[data-session-id="${otherSessionId}"]`).count(), 'new native session card was not focused')
  })
  await page.screenshot({ path: new URL('../artifacts/navigation-ui.png', import.meta.url).pathname })
} catch (error) {
  await page.screenshot({ path: new URL('../artifacts/ui-smoke-failure.png', import.meta.url).pathname }).catch(() => {})
  failures.push({ name: 'UI scenario setup', error: redact(error.message).split('\n').slice(0, 12).join('\n') })
} finally {
  await browser.close()
  const result = { checks, failures, errors }
  await writeFile(reportPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
}
if (failures.length || errors.length) process.exitCode = 1
