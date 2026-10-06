// Every run evaluates `vx.workspace.ts`, so what this package loads at
// import is paid by every run: a parser loads when its manager first
// digests, and `prune` when the verb runs.
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
m.bun()
m.pnpm()
const before = [...seen].sort()
await m.bun().commands.prune.run(['--help'], {}).catch(() => {})
console.log('SEEN ' + JSON.stringify({ before, after: [...seen].sort() }))
`

it('declaring a plugin loads no parser and not prune', async () => {
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
  // The control: the verb does load its module, so the probe sees a load.
  expect(after).toContain('prune.ts')
})
