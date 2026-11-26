// Turbo hashes a package's files nested workspace packages included
// (probed on 2.11.6). cal.com's `@calcom/app-store` holds its apps as
// packages its source imports by relative path; core's globs stop at a
// nested project, so an edit to an app replayed `@calcom/web#build`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { planRun } from '@vzn/vx/testing'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] }, check: { inputs: ['src/**'] } },
})

describe('turbo(): a nested workspace package', () => {
  it("keys its parent's tasks whose globs reach it, and their dependants", async () => {
    const root = ws.root
    const n = path.join(root, 'packages', 'lib', 'n')
    await mkdir(n, { recursive: true })
    await writeFile(path.join(n, 'package.json'), JSON.stringify({ name: 'n', version: '1.0.0' }))
    await writeFile(path.join(n, 'x.ts'), '1\n')
    await writeFile(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n  - "packages/lib/n"\n',
    )
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const keys = async () => {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      return Object.fromEntries(plan.tasks.map((t) => [t.node.id, t.node.id + t.hash]))
    }
    const before = await keys()
    await writeFile(path.join(n, 'x.ts'), '2\n')
    const after = await keys()
    expect({
      lib: after['lib#build'] !== before['lib#build'],
      app: after['app#build'] !== before['app#build'],
    }).toEqual({ lib: true, app: true })
  }, 30_000)
})

describe('turbo-map: a nested workspace package', () => {
  it('re-anchors each glob that reaches it, its negations with it, and takes it back', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'vx-turbo-nested-'))
    try {
      await writeFile(
        path.join(dir, 'turbo.json'),
        JSON.stringify({
          tasks: {
            a: {},
            b: { inputs: ['src/**', '!**/*.md'] },
            c: { inputs: ['lib/*.ts'] },
            d: { inputs: ['src/n/x.ts', 'm/*.ts', 'y.ts'] },
          },
        }),
      )
      const meta = (rel: string, scripts: object): PackageMeta => ({
        name: rel,
        dir: path.join(dir, rel),
        packageJson: { name: rel, scripts } as never,
        configPath: null,
      })
      const m = await mapTurboWorkspace(
        dir,
        [
          meta('p', { a: 'a', b: 'b', c: 'c', d: 'd' }),
          meta('p/src/n', {}),
          meta('p/src/n/deep', {}),
          meta('p/m', {}),
        ],
        { splice: (_k, v) => v, persistentTodo: 'PERSIST' },
      )
      const inputs = Object.fromEntries(
        m.projects
          .find((p) => p.name === 'p')!
          .tasks.map((t) => [t.name, (t.task as { inputs: object }).inputs]),
      )
      expect(inputs).toMatchObject({
        a: { workspaceFiles: ['p/**/*'] },
        b: {
          files: ['src/**', '!**/*.md', 'package.json', '!src/n/**'],
          workspaceFiles: ['p/src/n/**', '!p/**/*.md'],
        },
        c: { files: ['lib/*.ts', 'package.json'] },
        d: { files: ['y.ts', 'package.json'], workspaceFiles: ['p/src/n/x.ts', 'p/m/*.ts'] },
      })
      expect(inputs['c']).not.toHaveProperty('workspaceFiles')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
