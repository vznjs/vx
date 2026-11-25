// The `^gen` twin of turbo-dependency-outputs.test.ts: only a named
// uncached producer (`lib#gen`) was left out of the reader's fold, so
// behind `^gen` core answered the reader's probe before the producer ran,
// from the previous run's file, and the test hit on the old host.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: {
    gen: { cache: false, outputs: ['key.txt'] },
    test: {
      dependsOn: ['^gen'],
      inputs: ['$TURBO_DEFAULT$', { mode: 'dependencyOutputs', globs: ['key.txt'] }],
    },
  },
})

describe("turbo(): an upstream dependency's outputs as inputs", () => {
  it('keys a task on what an uncached ^producer wrote this run', async () => {
    const pkg = (name: string, scripts: object, deps?: object) =>
      writeFile(
        path.join(ws.root, 'packages', name, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          scripts,
          ...(deps ? { dependencies: deps } : {}),
        }),
      )
    await pkg('lib', { gen: 'cat ../../host > key.txt' })
    await pkg('app', { test: 'true' }, { lib: 'workspace:*' })
    await writeFile(path.join(ws.root, '.gitignore'), 'dist\nhost\nkey.txt\n')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const status = async (host: string) => {
      await writeFile(path.join(ws.root, 'host'), host)
      const r = await run({
        cwd: ws.root,
        tasks: ['app#test'],
        log: silent(),
        handleSignals: false,
      })
      return r.outcomes.find((o) => o.node.id === 'app#test')?.status
    }
    expect(await status('linux')).toBe('success')
    expect(await status('linux')).toBe('cache-hit')
    expect(await status('darwin')).toBe('success')
  }, 30_000)
})
