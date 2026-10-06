// Every run evaluates `vx.workspace.ts`, so what this package loads at
// import is paid by every run: the sink, the renderer and the Checks API
// client load only where a summary file is set.
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
    b.onLoad({ filter: /\\/vx-ci\\/src\\/[^/]+\\.ts$/ }, (a) => {
      seen.push(a.path.split('/').pop())
      return { contents: readFileSync(a.path, 'utf8'), loader: 'ts' }
    })
  },
})
const m = await import(process.argv[1])
const p = m.github({ summaryFile: '' })
p.telemetry({ warn() {} })
const before = [...seen].sort()
m.github({ summaryFile: '/dev/null', checks: false }).telemetry({ warn() {} })
console.log('SEEN ' + JSON.stringify({ before, after: [...seen].sort() }))
`

it('a run with no summary file loads no sink, renderer or Checks API client', async () => {
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
  expect(before).toEqual(['cache-scope.ts', 'index.ts', 'plugin.ts'])
  // The control: a summary file does load the sink, so the probe sees a load.
  expect(after).toEqual([...before, 'checks.ts', 'sink.ts', 'summary.ts'].sort())
})
