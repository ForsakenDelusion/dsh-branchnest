import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'

await rm('dist', { recursive: true, force: true })
await mkdir('dist', { recursive: true })
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', packages: 'external', sourcemap: true })
await build({ entryPoints: ['src/client/index.tsx'], outfile: 'dist/client.js', bundle: true,
  platform: 'browser', format: 'cjs', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  loader: { '.css': 'text' },
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-branchnest",factory:(require)=>{const module={exports:{}};const exports=module.exports;' },
  footer: { js: 'return module.exports;}});' } })
for (const face of ['host', 'client']) execFileSync('node_modules/.bin/tsc', ['--emitDeclarationOnly', '-p', `tsconfig.${face}.json`], { stdio: 'inherit' })
