// vercel/vercel: `test` reads `turbo-platform-cache-key.json` through
// `{ mode: "dependencyOutputs", from: ["//#generate:cache-keys"] }`, a
// `cache: false` task that records the host. Turbo hashes the file after
// its producer ran; vx folded only the producer's key, which an uncached
// task's output does not follow, so a test cached on one platform hit on
// another.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '@vzn/vx'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: {
    'lib#gen': { cache: false, outputs: ['key.txt'] },
    'app#test': {
      dependsOn: ['lib#gen'],
      inputs: [
        '$TURBO_DEFAULT$',
        { mode: 'dependencyOutputs', from: ['lib#gen'], globs: ['key.txt'] },
      ],
    },
  },
})

describe("turbo(): a dependency's outputs as inputs", () => {
  it('keys a task on what an uncached producer wrote this run', async () => {
    const pkg = (name: string, scripts: object) =>
      writeFile(
        path.join(ws.root, 'packages', name, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', scripts }),
      )
    await pkg('lib', { gen: 'cat ../../host > key.txt' })
    await pkg('app', { test: 'true' })
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
