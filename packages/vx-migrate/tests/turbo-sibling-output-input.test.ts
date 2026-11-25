// `build: { inputs: ["src/**", "gen/**"] }` beside `gen: { outputs:
// ["gen/**"] }`, no edge between them: Turbo walks `gen/**` on disk and
// re-runs build after gen rewrites it. The mapping took `gen/**` back
// from build's inputs, so build's key never saw gen's output and a
// second build replayed the first gen's bytes.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run } from '../../vx/tests/helpers/orchestrator.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'
import { migrateTurbo } from '../src/migrate-turbo.js'
import type { PackageMeta } from '../src/packages.js'

const ws = useTurboWorkspace({
  tasks: {
    build: { inputs: ['src/**', 'gen/**'], outputs: ['dist/**'] },
    gen: { inputs: ['schema.txt'], outputs: ['gen/**'] },
  },
})

const lib = () => path.join(ws.root, 'packages', 'lib')

async function setup(): Promise<void> {
  await writeFile(
    path.join(lib(), 'package.json'),
    JSON.stringify({
      name: 'lib',
      version: '1.0.0',
      scripts: {
        build: 'mkdir -p dist && cp gen/x.txt dist/',
        gen: 'mkdir -p gen && cp schema.txt gen/x.txt',
      },
    }),
  )
  await writeFile(path.join(lib(), 'schema.txt'), 'v1\n')
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
}

describe("turbo(): an explicit input over a sibling's output", () => {
  it("runs the reader uncached, so it never replays the sibling's old output", async () => {
    await setup()
    const runTask = async (task: string) => {
      const r = await run({ cwd: ws.root, tasks: [task], log: silent(), handleSignals: false })
      return r.outcomes.find((o) => o.node.id === `lib#${task}`)?.status
    }
    await runTask('gen')
    await runTask('build')
    await writeFile(path.join(lib(), 'schema.txt'), 'v2\n')
    await runTask('gen')
    const status = await runTask('build')
    expect([status, await readFile(path.join(lib(), 'dist', 'x.txt'), 'utf8')]).toEqual([
      'success',
      'v2\n',
    ])
  }, 30_000)

  it('the native writer writes it uncached, with a todo naming the sibling', async () => {
    await setup()
    const metas: PackageMeta[] = await Promise.all(
      ['lib', 'app'].map(async (name) => {
        const dir = path.join(ws.root, 'packages', name)
        const packageJson = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
        return { name, dir, packageJson, configPath: null }
      }),
    )
    const p = await migrateTurbo(ws.root, metas)
    const build = p.projects.find((x) => x.name === 'lib')!.tasks.find((t) => t.name === 'build')!
    expect([build.task!['cache'], build.task!['inputs'], build.todos]).toEqual([
      undefined,
      undefined,
      [
        'reads "gen/**", which "gen" writes and no dependsOn reaches — vx keys a task only on ' +
          'files no other task writes, so it runs uncached; add the edge or read the source ' +
          'instead in a vx.config to cache it',
      ],
    ])
  }, 30_000)
})
