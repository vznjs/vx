// `outputs: ["dist/**", "!dist/skip/**"]` with dist not gitignored: the
// task's own `**/*` inputs kept dist/skip, which the build writes, so each
// run warned "changed after its key was taken … not saved" and never
// cached. Turbo's outputs never key the task that writes them.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

// `outputs: ["*/**", "!src/**"]` (medusa's) or `lib/**` + `!lib/vendor/**`:
// the negated path is the task's committed source, which Turbo keys. Taken
// out of the task's inputs, an edit there replayed the old build.
for (const [label, outputs, src, script, out] of [
  [
    '*/** minus !src/**',
    ['*/**', '!src/**'],
    'src/index.js',
    'mkdir -p dist && cat src/*.js > dist/lib.js',
    'dist/lib.js',
  ],
  [
    'lib/** minus !lib/vendor/**',
    ['lib/**', '!lib/vendor/**'],
    'lib/vendor/v.js',
    'cat lib/vendor/v.js > lib/out.js',
    'lib/out.js',
  ],
] as const) {
  describe(`turbo(): a negated output over committed source (${label})`, () => {
    const ws = useTurboWorkspace({ tasks: { build: { dependsOn: ['^build'], outputs } } })
    it('stays an input: editing it misses and rebuilds', async () => {
      const lib = path.join(ws.root, 'packages', 'lib')
      await mkdir(path.join(lib, path.dirname(src)), { recursive: true })
      await writeFile(path.join(lib, src), '// v1\n')
      await writeFile(
        path.join(lib, 'package.json'),
        JSON.stringify({ name: 'lib', version: '1.0.0', scripts: { build: script } }),
      )
      Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
      const status = async () => {
        const r = await run({
          cwd: ws.root,
          tasks: ['lib#build'],
          log: silent(),
          handleSignals: false,
        })
        return r.outcomes.find((o) => o.node.id === 'lib#build')?.status
      }
      expect(await status()).toBe('success')
      expect(await status()).toBe('cache-hit')
      await writeFile(path.join(lib, src), '// v2\n')
      expect(await status()).toBe('success')
      expect(await readFile(path.join(lib, out), 'utf8')).toBe('// v2\n')
    }, 30_000)
  })
}
