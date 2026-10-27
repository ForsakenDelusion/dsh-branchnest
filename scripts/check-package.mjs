import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { encoding: 'utf8' }))
const files = new Set(packed.files.map(file => file.path))
for (const required of ['dist/index.js', 'dist/client.js', 'dist/types/index.d.ts', 'locale/en.json', 'locale/zh.json', 'cordis.patch.yml', 'LICENSE', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
  assert.ok(files.has(required), `Missing package file: ${required}`)
}
for (const file of files) {
  assert.match(file, /^(?:dist\/[\w./-]+|locale\/[\w-]+\.json|cordis\.patch\.yml|LICENSE|README\.md|THIRD_PARTY_NOTICES\.md|package\.json)$/, `Unexpected package file: ${file}`)
}
const client = await readFile('dist/client.js', 'utf8')
assert.ok(client.includes(`id:${JSON.stringify(manifest.name)}`), 'Browser module id must match the package name')
assert.ok((await readFile('cordis.patch.yml', 'utf8')).includes(`name: ${manifest.name}`), 'Host bundle must enable this package')
for (const locale of ['en', 'zh']) JSON.parse(await readFile(`locale/${locale}.json`, 'utf8'))
console.log(`Package checked: ${manifest.name}@${manifest.version}, ${files.size} files, ${packed.size} bytes`)
