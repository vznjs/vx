// Every run evaluates `.vx/workspace.ts`, so what this package loads at
// import is paid by every run: a parser loads when its manager first
// digests, and no other parser with it.
import path from 'node:path'
import { expect, it } from 'bun:test'

const PROBE = `
const { readFileSync } = require('node:fs')
const seen = []
// A synchronous onLoad: an async one makes the module async, and
// \`require\` refuses an async module.
Bun.plugin({
  name: 'seen',
  setup(b) {
    b.onLoad({ filter: /\\/vx-lockfile\\/src\\/[^/]+\\.ts$/ }, (a) => {
      seen.push(a.path.split('/').pop())
      return { contents: readFileSync(a.path, 'utf8'), loader: 'ts' }
    })
  },
})
const m = await import(process.argv[1])
const bun = m.bun()
m.pnpm()
const before = [...seen].sort()
const lock = new TextEncoder().encode('{ "lockfileVersion": 1, "workspaces": { "": { "name": "r" } }, "packages": {} }')
bun.fingerprint.affected(
  { file: 'bun.lock', before: lock, after: lock },
  { workspaceRoot: '/w', projects: [] },
)
console.log('SEEN ' + JSON.stringify({ before, after: [...seen].sort() }))
`

it('declaring a plugin loads no parser; a digest loads only its own', async () => {
  const proc = Bun.spawn(
    [process.execPath, '-e', PROBE, path.join(import.meta.dir, '..', 'src', 'index.ts')],
    { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' })
  const line = out.split('\n').find((l) => l.startsWith('SEEN ')) ?? 'SEEN {}'
  const { before, after } = JSON.parse(line.slice(5)) as { before: string[]; after: string[] }
  expect(before).toEqual(['index.ts'])
  // The control: a digest does load its parser, so the probe sees a load.
  expect(after).toContain('bun.ts')
  expect(after).not.toContain('pnpm.ts')
})

const SETTINGS_PROBE = `
const { readFileSync, mkdtempSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const seen = []
Bun.plugin({
  name: 'seen',
  setup(b) {
    b.onLoad({ filter: /\\/vx-lockfile\\/src\\/[^/]+\\.ts$/ }, (a) => {
      seen.push(a.path.split('/').pop())
      return { contents: readFileSync(a.path, 'utf8'), loader: 'ts' }
    })
  },
})
const m = await import(process.argv[1])
const root = mkdtempSync(path.join(require('node:os').tmpdir(), 'vx-lazy-'))
writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages: [a]\\nnodeLinker: hoisted\\n')
const key = await m.pnpm().key({ projectDir: root }, { workspaceRoot: root, cacheDir: root, warn() {} })
console.log('SEEN ' + JSON.stringify({ key: Object.keys(key ?? {}), seen: [...seen].sort() }))
`

// A warm run keys every task on the install settings and parses no
// lockfile (its digests are memoized): pnpm-workspace.yaml's fold loaded
// the whole pnpm parser for them, ~1.5 ms a run.
it("pnpm()'s settings fold loads no lockfile parser", async () => {
  const proc = Bun.spawn(
    [process.execPath, '-e', SETTINGS_PROBE, path.join(import.meta.dir, '..', 'src', 'index.ts')],
    { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' })
  const line = out.split('\n').find((l) => l.startsWith('SEEN ')) ?? 'SEEN {}'
  const { key, seen } = JSON.parse(line.slice(5)) as { key: string[]; seen: string[] }
  expect(key).toContain('pnpm-workspace.yaml')
  expect(seen).not.toContain('pnpm.ts')
})
