// Cypress's atomized `e2e-ci` forwards params to each spec's task. The
// todo named each spec, so a project with N specs carried N todos and a
// run printed a warning line per spec; it is one line per task now, the
// same text in every project, so the run's warnings group them.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-forward-todo-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function meta(name: string): Promise<ProjectMeta> {
  const dir = path.join(root, 'apps', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
  return { name, dir, packageJson: { name } as never, configPath: null }
}

function atomized(specs: string[]) {
  const targets: Record<string, unknown> = {}
  for (const s of specs) targets[`e2e-ci--${s}`] = { command: `cypress run --spec ${s}` }
  targets['e2e-ci'] = {
    executor: 'nx:noop',
    options: { fix: true },
    dependsOn: specs.map((s) => ({
      target: `e2e-ci--${s}`,
      params: 'forward',
      options: 'forward',
    })),
  }
  return targets
}

it('one todo per forwarding kind per task, naming no spec', async () => {
  const metas = await Promise.all(['a-e2e', 'b-e2e'].map(meta))
  const graph = {
    nodes: {
      'a-e2e': {
        data: { root: 'apps/a-e2e', targets: atomized(['x.cy.ts', 'y.cy.ts', 'z.cy.ts']) },
      },
      'b-e2e': { data: { root: 'apps/b-e2e', targets: atomized(['w.cy.ts']) } },
    },
    dependencies: {},
  }
  const m = await mapNxWorkspace(root, metas, graph as NxGraph, {
    cacheable: new Set(),
  })
  const todos = m.projects.map((p) => p.tasks.find((t) => t.name === 'e2e-ci')!.todos)
  const once = [
    'dependsOn `options: "forward"` is not supported — the dependency runs with its own options, not this target\'s',
    'dependsOn `params: "forward"` is not supported — forward args via `vx run … -- args` instead',
  ]
  expect(todos).toEqual([once, once])
})
