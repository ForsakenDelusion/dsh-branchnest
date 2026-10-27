// Render the real reader with deterministic history; only the unrelated message
// renderer is stubbed. Optional tools: react-dom 18 and Playwright (or point
// READER_REACT_DOM / PLAYWRIGHT_MODULE at an existing installation).
// This checks CSS drag-region declarations. Physical Electron movement requires
// the independent native harness generated in artifacts/reader-native-qa.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const repo = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(repo, 'artifacts', 'reader-native-qa')
const reactDom = process.env.READER_REACT_DOM || require.resolve('react-dom/client')
const react = path.dirname(createRequire(reactDom).resolve('react/package.json'))
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
await mkdir(output, { recursive: true })
const entry = `import React from 'react'; import {createRoot} from ${JSON.stringify(reactDom)};
import {SessionReader} from ${JSON.stringify(path.join(repo, 'src/client/session-reader.tsx'))};
const position={x:0,y:0,width:470,height:540,collapsed:false};
const snapshot={nodes:[{sessionId:'source',title:'阅读页回归验证',position,running:false},{sessionId:'child',title:'一个分支',position,running:false}],notes:[],links:[{fromId:'source',toId:'child'}]};
window.readerCalls=[];
createRoot(document.getElementById('root')).render(<section className="pc-root">
<header className="pc-topbar"><button>原画布项目开关</button><button>原画布新建</button></header>
<SessionReader api={{messages:async()=>({messages:[{seq:1,role:'assistant',text:'回答正文',hash:'a'.repeat(64)}],running:false,hasMore:false,error:null}),contextPreview:async()=>({items:[],omitted:[]})}}
workspaceId="workspace" snapshot={snapshot} sessionId="source" drafts={new Map()}
onClose={()=>window.readerCalls.push('close')} onOpen={id=>window.readerCalls.push(id)} onOpenNative={id=>window.readerCalls.push(id)} onSubmit={async()=>{}} /></section>);`
const bundle = await build({ stdin: { contents: entry, loader: 'tsx', resolveDir: repo }, bundle: true, write: false,
  jsx: 'automatic', format: 'iife', alias: { react }, plugins: [{ name: 'reader-message-fixture', setup(build) {
    build.onResolve({ filter: /\.\/message-body\.tsx$/ }, () => ({ path: 'message-fixture', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function MessageBody({message}) {return message.text}', loader: 'jsx' }))
  } }] })
const css = await readFile(path.join(repo, 'src/client/style.css'), 'utf8')
const baseStyle = 'html,body,#root{height:100%;margin:0}html{--dsh-frame-top-clearance:48px}'
await Promise.all([
  writeFile(path.join(output, 'renderer.js'), bundle.outputFiles[0].text),
  writeFile(path.join(output, 'reader.css'), css),
])
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end(`<html data-platform="darwin"><style>${baseStyle}</style><style>${css}</style><div id="root"></div><script>${bundle.outputFiles[0].text}</script></html>`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser
const results = []
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}) })
  for (const [width, reducedMotion] of [[1280, 'no-preference'], [800, 'no-preference'], [480, 'no-preference'], [1280, 'reduce']]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.getByRole('heading', { name: '阅读页回归验证' }).waitFor()
    const result = { width, reducedMotion }
    result.header = await page.locator('.pc-reader-header').evaluate(element => ({
      region: getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      ancestorNoDrag: (() => { for (let parent = element.parentElement; parent; parent = parent.parentElement)
        if (getComputedStyle(parent).getPropertyValue('-webkit-app-region') === 'no-drag') return true; return false })(),
      height: element.getBoundingClientRect().height,
    }))
    assert.equal(result.header.region, 'drag'); assert.equal(result.header.ancestorNoDrag, false)
    assert.equal(await page.locator('.pc-topbar').evaluate(element => getComputedStyle(element).visibility), 'hidden', 'covered canvas controls must not leave native no-drag regions behind')
    const toggle = page.locator('.pc-reader-header button[aria-controls]')
    assert.equal(await toggle.count(), 1)
    assert.equal(await page.locator('.pc-reader-branches button.pc-reader-sidebar-toggle').count(), 0)
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    result.hidden = await page.locator('.pc-reader-branches').evaluate(element => ({ inert: element.inert, ariaHidden: element.getAttribute('aria-hidden') }))
    assert.equal(result.hidden.inert, true); assert.equal(result.hidden.ariaHidden, 'true')
    await page.waitForTimeout(50)
    result.midWidth = await page.locator('.pc-reader-branches').evaluate(element => element.getBoundingClientRect().width)
    await page.waitForTimeout(250)
    assert.equal(await page.locator('.pc-reader-branches').evaluate(element => getComputedStyle(element).visibility), 'hidden')
    result.hiddenWidth = await page.locator('.pc-reader-branches').evaluate(element => element.getBoundingClientRect().width)
    if (width > 540) assert.ok(result.hiddenWidth < 2)
    if (reducedMotion === 'reduce') assert.ok(result.midWidth < 2, 'reduced motion switches immediately')
    // Hidden branch controls must not become the reader focus trap's last control.
    await page.getByRole('button', { name: 'Go deeper' }).focus()
    await page.keyboard.press('Tab')
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Canvas')
    await toggle.click(); await page.waitForTimeout(250)
    result.shownWidth = await page.locator('.pc-reader-branches').evaluate(element => element.getBoundingClientRect().width)
    assert.ok(result.shownWidth >= 200)
    assert.equal(await page.locator('.pc-reader-branches').evaluate(element => element.inert), false)
    await page.getByRole('button', { name: '在 DSH 中打开' }).click()
    assert.deepEqual(await page.evaluate(() => window.readerCalls), ['source'])
    assert.deepEqual(errors, [])
    await page.screenshot({ path: path.join(output, `reader-${width}-${reducedMotion}.png`) })
    results.push(result); await page.close()
  }
  await writeFile(path.join(repo, 'artifacts', 'reader-ui-smoke.json'), JSON.stringify({ checks: [
    'reader header has no ancestor no-drag conflict; covered canvas header is hidden',
    'one persistent top sidebar toggle; close/open works at 1280, 800 and 480px',
    'closed sidebar is inert, hidden, and skipped by the keyboard focus trap',
    'sidebar transitions and reduced-motion mode preserve layout',
    'native open callback receives the current session ID',
  ], results }, null, 2))
  console.log('PASS: reader header, sidebar, keyboard focus and native navigation (4 viewport/motion scenarios)')
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
