// Nx runs `nx:run-script` as `<pm> run <name>`, which sets `$npm_*`; the
// inlined body ran without them, so `echo $npm_package_version` printed
// nothing under `nx()`. The ones the body reads are defined from the
// manifest, as core's `vx init` defines them (D-34).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-run-script-env-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function exec(scripts: Record<string, string>, script: string) {
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const packageJson = { name: '@acme/a', version: '1.2.3', scripts }
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson))
  const meta: ProjectMeta = {
    name: '@acme/a',
    dir,
    packageJson: packageJson as never,
    configPath: null,
  }
  const nodes = {
    a: {
      data: {
        root: 'packages/a',
        targets: { [script]: { executor: 'nx:run-script', options: { script } } },
      },
    },
  }
  const m = await mapNxWorkspace(root, [meta], { nodes, dependencies: {} } as NxGraph, {
    persistentTodo: 'PERSIST',
    cacheable: new Set(),
  })
  const t = m.projects[0]!.tasks.find((x) => x.name === script)!
  const e = t.task!['exec'] as { env: { define: Record<string, string> } }
  const define = Object.fromEntries(
    Object.entries(e.env.define).filter(([k]) => k.startsWith('npm_')),
  )
  return { define, todos: t.todos }
}

it('defines the $npm_* a script reads from the manifest; any other is a todo', async () => {
  expect(
    await exec(
      { gen: 'echo $npm_package_name ${npm_package_version} $npm_lifecycle_event $npm_config_x' },
      'gen',
    ),
  ).toEqual({
    define: {
      npm_package_name: '@acme/a',
      npm_package_version: '1.2.3',
      npm_lifecycle_event: 'gen',
    },
    todos: [
      "nx:run-script: `$npm_config_x` is set by the package manager's `run`, not here — unset",
    ],
  })
})

// A folded `pre` hook runs as its own script under npm, with its own event.
it('a folded hook leaves npm_lifecycle_event unset, with a todo', async () => {
  expect(await exec({ pregen: 'echo pre', gen: 'echo $npm_lifecycle_event' }, 'gen')).toEqual({
    define: {},
    todos: [
      "nx:run-script: `$npm_lifecycle_event` is set by the package manager's `run`, not here — unset",
    ],
  })
})
