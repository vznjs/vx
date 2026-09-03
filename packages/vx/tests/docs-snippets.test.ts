// The plugins guide says "Everything below is real, runnable code
// against the types exported from `@vzn/vx`." This pins the claim: every
// TypeScript block in the guide type-checks against the façade, so a seam
// that moves turns the guide red before an author copies a stale block.
// Blocks that open with `interface` are contract sketches with untyped
// parameters and are skipped on purpose.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'bun:test'

const GUIDE = path.resolve(import.meta.dir, '../../../apps/docs/src/content/docs/guides/plugins.md')
const OXLINT = path.resolve(import.meta.dir, '../../../node_modules/.bin/oxlint')

it('every code block in the plugins guide type-checks against @vzn/vx', async () => {
  const text = await Bun.file(GUIDE).text()
  const blocks = [...text.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!)
  expect(blocks.length).toBeGreaterThan(5)
  // Inside packages/vx so `@vzn/vx` resolves to this package and the
  // package's tsconfig applies.
  const dir = await mkdtemp(path.join(import.meta.dir, '.snippets-'))
  try {
    let checked = 0
    for (const [i, block] of blocks.entries()) {
      const firstCode = block.split('\n').find((l) => l.trim() !== '' && !l.startsWith('import '))
      if (firstCode?.startsWith('interface ')) continue
      await writeFile(path.join(dir, `block-${String(i).padStart(2, '0')}.ts`), block)
      checked++
    }
    expect(checked).toBeGreaterThan(5)
    const p = Bun.spawnSync({ cmd: [OXLINT, '--type-aware', dir], stdout: 'pipe', stderr: 'pipe' })
    const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
    const errors = out.split('\n').filter((l) => /^\s*x |: error /.test(l))
    expect({ exitCode: p.exitCode, errors }).toEqual({ exitCode: 0, errors: [] })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
