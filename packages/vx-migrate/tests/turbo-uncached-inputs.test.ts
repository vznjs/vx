// A `cache: false` generator that reads a file outside its package
// (`$TURBO_ROOT$/shared/schema.txt`): Turbo hashes it into the generator's
// hash and so into every dependent's. vx keys a task with no cache block on
// its own package only, and the mapping dropped the input, so an edit to
// the schema replayed the dependent's old build (Growth, 2026-10-16). Each
// dependent now keys what its uncached producers read outside their package.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: {
    'lib#gen': { cache: false, inputs: ['$TURBO_ROOT$/shared/schema.txt'] },
    'lib#mid': { cache: false, dependsOn: ['gen'] },
    'app#build': { dependsOn: ['lib#mid'], outputs: ['out.txt'] },
  },
})

describe('turbo(): an uncached producer that reads outside its package', () => {
  it('keys its dependents on what it reads, through an uncached chain', async () => {
    const pkg = (name: string, scripts: object) =>
      writeFile(
        path.join(ws.root, 'packages', name, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', scripts }),
      )
    await pkg('lib', { gen: 'cp ../../shared/schema.txt ../app/gen.txt', mid: 'true' })
    await pkg('app', { build: 'cat gen.txt > out.txt' })
    await mkdir(path.join(ws.root, 'shared'), { recursive: true })
    await writeFile(path.join(ws.root, '.gitignore'), 'dist\ngen.txt\nout.txt\n')
    const status = async (schema: string) => {
      await writeFile(path.join(ws.root, 'shared', 'schema.txt'), schema)
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
      const r = await run({
        cwd: ws.root,
        tasks: ['app#build'],
        log: silent(),
        handleSignals: false,
      })
      return r.outcomes.find((o) => o.node.id === 'app#build')?.status
    }
    expect(await status('SCHEMA1')).toBe('success')
    expect(await status('SCHEMA1')).toBe('cache-hit')
    // Before the fix: a hit replaying SCHEMA1.
    expect(await status('SCHEMA2')).toBe('success')
    expect(await Bun.file(path.join(ws.root, 'packages', 'app', 'out.txt')).text()).toBe('SCHEMA2')
  }, 30_000)
})
