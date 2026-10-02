// clerk's builds output `*/package.json`: the subpath stubs it commits.
// A wildcard first segment was refused as reaching the sources, so every
// migrated clerk build ran uncached. With a literal rest it reaches only
// the files of that name one level down; the committed ones are taken back.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { run, type ProjectMeta } from '@vzn/vx'
import { trackedKinds } from '../src/tracked-outputs.js'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({ tasks: { build: { outputs: ['*/package.json'] } } })

describe('turbo(): a `*/package.json` output beside committed stubs', () => {
  it('caches the build and keeps the stubs', async () => {
    const lib = path.join(ws.root, 'packages', 'lib')
    await writeFile(
      path.join(lib, 'package.json'),
      JSON.stringify({
        name: 'lib',
        version: '1.0.0',
        scripts: { build: 'mkdir -p gen && echo {} > gen/package.json' },
      }),
    )
    await mkdir(path.join(lib, 'web'))
    await writeFile(path.join(lib, 'web', 'package.json'), '{"main":"../dist/web.js"}\n')
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: ws.root })
    const build = async () => {
      const r = await run({
        cwd: ws.root,
        tasks: ['lib#build'],
        log: silent(),
        handleSignals: false,
      })
      return r.outcomes.find((o) => o.node.id === 'lib#build')!.status
    }
    expect({
      first: await build(),
      second: await build(),
      stub: await Bun.file(path.join(lib, 'web', 'package.json')).text(),
    }).toEqual({ first: 'success', second: 'cache-hit', stub: '{"main":"../dist/web.js"}\n' })
  }, 30_000)
})

describe('turbo-map: a wildcard-first output with a literal rest', () => {
  const map = async (output: string, tracked: string[]) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-wild-'))
    try {
      await writeFile(
        path.join(dir, 'turbo.json'),
        JSON.stringify({ tasks: { build: { outputs: [output] } } }),
      )
      const meta: ProjectMeta = {
        name: 'a',
        dir: path.join(dir, 'a'),
        packageJson: { name: 'a', scripts: { build: 'b' } } as never,
        configPath: null,
      }
      const m = await mapTurboWorkspace(dir, [meta], {
        splice: (_k, v) => v,
        persistentTodo: 'PERSIST',
        tracked: trackedKinds(tracked.map((f) => `a/${f}`)),
      })
      const t = m.projects[0]!.tasks[0]!
      return (
        (t.task!['cache'] as { outputs: { files: unknown } } | undefined)?.outputs.files ?? null
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const stubs = (n: number) =>
    Array.from({ length: n }, (_, i) => `s${String(i).padStart(2, '0')}/package.json`)

  it('takes back each committed match, up to the runtime limit', async () => {
    expect({
      none: await map('*/package.json', ['package.json', 'src/index.ts', 'src/a/package.json']),
      two: await map('*/package.json', ['package.json', 'web/package.json', 'node/package.json']),
      limit: ((await map('*/package.json', stubs(16))) as string[] | null)?.length,
      over: await map('*/package.json', stubs(17)),
      wildRest: await map('*/*.json', ['web/package.json']),
    }).toEqual({
      none: ['*/package.json'],
      two: ['*/package.json', '!node/package.json', '!web/package.json'],
      limit: 17,
      over: null,
      wildRest: null,
    })
  })
})
