// A dependency-only server stops once no task left uses it, not at the end
// of the graph: one held its machine's cores while unrelated tasks ran.

import { readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import type { Logger } from '../src/report/index.js'
import { run } from './helpers/orchestrator.js'
import { unneededServers } from '../src/orchestrator/persistent.js'
import type { TaskNode } from '../src/graph/index.js'

process.env['VX_TEST_KILL_GRACE'] = '200ms'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-server-unneeded-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

// Polls up to 5 s for the server's exit, so a slow stop is not read as alive.
const probe = (file: string) =>
  `pid=$(cat api.pid); for i in $(seq 50); do kill -0 $pid 2>/dev/null || { echo dead > ${file}; exit 0; }; sleep 0.1; done; echo alive > ${file}`

it('a server stops when its last user finishes, while the graph still runs', async () => {
  const dir = await addProject(
    root,
    'app',
    `
      export default {
        tasks: {
          api: { exec: { command: 'echo $$ > api.pid; exec sleep 30', persistent: {} } },
          a: { dependsOn: ['api'], exec: { command: 'true' } },
          b: { dependsOn: ['api', 'a'], exec: { command: 'kill -0 $(cat api.pid) && echo alive > b.txt' } },
          late: { dependsOn: ['b'], exec: { command: ${JSON.stringify(probe('late.txt'))} } },
        },
      }
    `,
  )
  const lines: string[] = []
  const log: Logger = {
    status: (l) => void lines.push(l),
    taskStdout: () => {},
    taskStderr: (_n, c) => void lines.push(c),
    taskComplete: () => {},
  }
  const r = await run({ cwd: root, tasks: ['late'], projects: ['app'], log })
  expect(
    r.outcomes.map((o) => [o.node.id, o.status]).sort((x, y) => x[0]!.localeCompare(y[0]!)),
  ).toEqual([
    ['app#a', 'success'],
    ['app#api', 'success'],
    ['app#b', 'success'],
    ['app#late', 'success'],
  ])
  // Still up for its second user, gone before the task after them.
  expect(readFileSync(path.join(dir, 'b.txt'), 'utf8').trim()).toBe('alive')
  expect(readFileSync(path.join(dir, 'late.txt'), 'utf8').trim()).toBe('dead')
  // Its stop is no crash.
  expect(lines.filter((l) => l.includes('exited with code'))).toEqual([])
}, 30_000)

const node = (id: string, deps: string[], extra: Record<string, unknown> = {}) =>
  ({
    id,
    deps,
    requested: false,
    config: { exec: { command: 'x' } },
    ...extra,
  }) as unknown as TaskNode
const server = (id: string, deps: string[] = [], requested = false) =>
  node(id, deps, { requested, config: { exec: { command: 'x', persistent: {} } } })
const group = (id: string, deps: string[]) => node(id, deps, { config: {} })

it('unneededServers reads users through groups, chains servers, and keeps the requested', () => {
  const nodes = new Map<string, TaskNode>(
    [
      server('db'),
      server('api', ['db']),
      group('svc', ['api']),
      node('t1', ['svc']),
      node('t2', ['api']),
      server('dev', [], true),
      node('t3', ['dev']),
    ].map((n) => [n.id, n]),
  )
  const finished = unneededServers(nodes, true)
  expect(finished('api')).toEqual([])
  expect(finished('t1')).toEqual([])
  // api's last user: api goes, and db, whose only user api was.
  expect(finished('t2')).toEqual(['api', 'db'])
  // A requested server is kept in the foreground...
  expect(finished('t3')).toEqual([])
  // ...and stops as any other outside it.
  expect(unneededServers(nodes, false)('t3')).toEqual(['dev'])
})
