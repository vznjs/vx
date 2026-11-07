// `outputs: ["dist/**", "!dist/skip/**"]` with dist not gitignored: the
// task's own `**/*` inputs kept dist/skip, which the build writes, so each
// run warned "changed after its key was taken … not saved" and never
// cached. Turbo's outputs never key the task that writes them.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**', '!dist/skip/**'] } },
})

describe('turbo(): a negated output', () => {
  it("is no input of the task that writes it, so the run's result is saved", async () => {
    await writeFile(
      path.join(ws.root, 'packages', 'lib', 'package.json'),
      JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        scripts: { build: 'mkdir -p dist/skip && echo a > dist/a.js && date +%N > dist/skip/s' },
      }),
    )
    await writeFile(path.join(ws.root, '.gitignore'), '')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const status = async () => {
      const log = silent()
      const r = await run({ cwd: ws.root, tasks: ['lib#build'], log, handleSignals: false })
      return [
        r.outcomes.find((o) => o.node.id === 'lib#build')?.status,
        log.lines.filter((l) => l.includes('changed after')),
      ]
    }
    expect(await status()).toEqual(['success', []])
    expect(await status()).toEqual(['cache-hit', []])
  }, 30_000)
})
