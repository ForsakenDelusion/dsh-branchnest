// Build a local development package: version bump WITHOUT touching the committed manifest.
//
// The packaged manifest carries `<nextPatch>-dev.<Date.now()>` so a locally installed dev
// build is distinguishable from a release build, while `package.json` and `package-lock.json`
// in the working tree stay at the committed stable version.
//
// `npm pack` always reads the manifest of the directory it packs, and manifests staged in a
// temp directory cannot build this repo (esbuild/tsc resolve their binaries by walking up from
// the script location). So the run stages a full package in a sibling temp dir - this tree's
// files plus a `node_modules` symlink back to the real dependencies - with only `version`
// changed, and packs that staging dir. `prepack` still runs (so `dist/` is rebuilt by
// `npm run build` from the staged manifest) and the tarball ships the dev version.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const repoRoot = new URL('..', import.meta.url).pathname
const artifacts = join(repoRoot, 'artifacts')
const source = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
const name = source.name
assert.match(source.version, /^\d+\.\d+\.\d+$/, `package.json version must be a stable x.y.z release, got ${source.version}`)
const [major, minor, patch] = source.version.split('.').map(Number)
const version = `${major}.${minor}.${patch + 1}-dev.${Date.now()}`
const label = name.replace(/^@[^/]+\//, '')
const archive = join(artifacts, `${label}-${version}.tgz`)
const record = join(artifacts, `${label}-dev-package.json`)

// Mirror the working tree (including the local-only `docs/` that screenshots.json points at),
// leaving out what a pack never reads: dependencies (linked separately), npm output and the
// cache. `.git` is kept so a parent repository's workspace discovery still sees the same root.
const skipped = new Set(['node_modules', 'artifacts', '.npm-cache'])
const entries = (await readdir(repoRoot)).filter(entry => !skipped.has(entry))

const staging = await mkdtemp(join(repoRoot, '..', `.${label}-dev-pack-`))
try {
  for (const entry of entries) await cp(join(repoRoot, entry), join(staging, entry), { recursive: true })
  await symlink(join(repoRoot, 'node_modules'), join(staging, 'node_modules'), 'dir')
  await writeFile(join(staging, 'package.json'), `${JSON.stringify({ ...source, version }, null, 2)}\n`)
  await mkdir(artifacts, { recursive: true })

  const pack = args => {
    const output = execFileSync('npm', ['pack', ...args, '--json'], { cwd: staging, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    const [result] = JSON.parse(output)
    assert.equal(result.version, version, `npm packed ${result.name}@${result.version}, expected ${version}`)
    return result
  }

  const packed = pack(['--pack-destination', artifacts])
  assert.equal(join(artifacts, packed.filename), archive, `unexpected tarball name ${packed.filename}`)
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex')
  await writeFile(record, JSON.stringify({ version, archive, sha256, sourceVersion: source.version }, null, 2))

  console.log(`dev package: ${version} (${packed.files.length} files, ${packed.size} bytes packed)`)
  console.log(`archive: ${archive}`)
  console.log(`sha256: ${sha256}`)
  console.log(`manifest: ${record}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
