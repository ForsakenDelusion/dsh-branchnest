import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Execute the actual Actions guard against a disposable repository and local
// remote. This catches an accidental first-push Release without contacting GitHub.
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const guardStep = workflow.split('- name: Check that this version should be released')[1]!.split('\n      - name:')[0]!
const guard = guardStep.split('run: |\n')[1]!.split('\n').map(line => line.replace(/^          /, '')).join('\n')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'branchnest-release-'))
  const remote = join(root, 'remote.git'), repo = join(root, 'repo')
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' })
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('config', 'user.name', 'Release fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('remote', 'add', 'origin', remote)
  const manifest = (version: string) => writeFileSync(join(repo, 'package.json'), JSON.stringify({ version }))
  manifest('0.4.3'); git('add', 'package.json'); git('commit', '-m', 'previous version')
  const before = git('rev-parse', 'HEAD')
  git('push', 'origin', 'main')
  manifest('0.4.4'); git('add', 'package.json'); git('commit', '-m', 'next version')
  return { root, repo, git, manifest, before,
    run(event = 'push', base = before) {
      const output = join(root, 'output'); writeFileSync(output, '')
      const result = spawnSync('bash', ['-e', '-c', guard], { cwd: repo, encoding: 'utf8', env: {
        ...process.env, GITHUB_OUTPUT: output, RELEASE_EVENT_NAME: event, RELEASE_BEFORE: base,
      } })
      return { status: result.status, output: readFileSync(output, 'utf8') }
    },
    dispose() { rmSync(root, { recursive: true, force: true }) },
  }
}

test('the first main push checks source without publishing a Release', () => {
  const f = fixture()
  try { const result = f.run('push', '0'.repeat(40)); assert.equal(result.status, 0); assert.match(result.output, /skip=true/) }
  finally { f.dispose() }
})

test('a package edit without a version change does not publish an untagged version', () => {
  const f = fixture()
  try { const result = f.run('push', f.git('rev-parse', 'HEAD')); assert.equal(result.status, 0); assert.match(result.output, /skip=true/) }
  finally { f.dispose() }
})

test('a changed stable version or an explicit manual run can publish', () => {
  const f = fixture()
  try {
    for (const [event, base] of [['push', f.before], ['workflow_dispatch', '0'.repeat(40)]]) {
      const result = f.run(event, base); assert.equal(result.status, 0); assert.match(result.output, /skip=false/)
    }
  } finally { f.dispose() }
})

test('existing tags and prerelease versions are skipped', () => {
  const f = fixture()
  try {
    f.git('tag', 'v0.4.4'); f.git('push', 'origin', 'v0.4.4')
    assert.match(f.run().output, /skip=true/)
    f.manifest('0.4.5-dev.1'); assert.match(f.run().output, /skip=true/)
  } finally { f.dispose() }
})

test('an unavailable remote fails the guard instead of creating a Release', () => {
  const f = fixture()
  try { f.git('remote', 'set-url', 'origin', join(f.root, 'missing.git')); assert.notEqual(f.run().status, 0) }
  finally { f.dispose() }
})
