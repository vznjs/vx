// A migrated command that still runs Nx works only while Nx is installed,
// and native config is meant to outlive it: a migration says so on the
// task (P2-9). `nx()`, which runs with Nx present, does not.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const rc = (command: string) => ({ executor: 'nx:run-commands', options: { command } })
const graph = {
  nodes: {
    a: {
      name: 'a',
      data: {
        root: 'libs/a',
        targets: {
          chain: rc('nx run b:build'),
          npx: rc('npx nx test b --watch=false'),
          many: rc('echo go && pnpm nx run-many -t lint'),
          exec: rc('nx exec -- tsc -p tsconfig.json'),
          plain: rc('tsc -p tsconfig.json && node scripts/unix.js'),
          words: rc('echo onyx lynx'),
        },
      },
    },
  },
  dependencies: {},
}

async function todos(migration: boolean): Promise<Record<string, string[]>> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-self-'))
  try {
    await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
    const metas: ProjectMeta[] = [
      {
        name: 'a',
        dir: path.join(root, 'libs', 'a'),
        packageJson: { name: 'a' },
        configPath: null,
      },
    ]
    const mapped = await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
      cacheable: new Set(),
      migration,
    })
    return Object.fromEntries(mapped.projects[0]!.tasks.map((t) => [t.name, t.todos]))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const runs = (sub: string) =>
  `the command runs \`nx ${sub}\`, which needs Nx installed — name that task in dependsOn, or run its command here`

describe('a migrated command that runs Nx', () => {
  it('carries a TODO; a command that does not, none', async () => {
    expect(await todos(true)).toEqual({
      chain: [runs('run')],
      npx: [runs('test')],
      many: [runs('run-many')],
      exec: [
        'the command runs under `nx exec --`, which needs Nx installed — drop `nx exec --` and keep the command after it',
      ],
      plain: [],
      words: [],
    })
  })

  // Control: the plugin runs with Nx installed.
  it('nx() says nothing', async () => {
    const all = await todos(false)
    expect(Object.values(all).flat()).toEqual([])
  })
})
