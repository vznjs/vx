// A task another machine ran is done once it ran there: its files come to
// this machine meanwhile (`download: 'trailing'`), its dependants there start
// at once, and the run ends only with every file here. Asked only of a task
// nothing on this machine reads before then (`trailable`).
import { existsSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { TaskNode } from '../src/graph/index.js'
import { trailable, TrailingOutputs } from '../src/orchestrator/trailing-outputs.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const node = (id: string, deps: string[], config: object): [string, TaskNode] => [
  id,
  { id, deps, config } as unknown as TaskNode,
]
const cmd = { exec: { command: 'x' } }

describe('trailable', () => {
  const all = () => true
  const none = () => false
  it('is an uncached task on another machine whose dependants read nothing here', () => {
    const nodes = new Map([
      node('make', [], cmd),
      node('use', ['make'], cmd),
      node('group', ['use'], {}),
    ])
    expect([...trailable(nodes, none, all)].sort()).toEqual(['make', 'use'])
  })
  it('is no cached task, server or task placed here', () => {
    const nodes = new Map([
      node('cached', [], { ...cmd, cache: true }),
      node('server', [], { exec: { command: 'x', persistent: {} } }),
      node('here', [], cmd),
    ])
    expect([...trailable(nodes, none, (id) => id !== 'here')]).toEqual([])
  })
  it('is no task with a dependant, however far, that runs here', () => {
    const nodes = new Map([
      node('make', [], cmd),
      node('mid', ['make'], cmd),
      node('here', ['mid'], cmd),
    ])
    expect([...trailable(nodes, none, (id) => id !== 'here')]).toEqual([])
  })
  it('is no task with a dependant whose key is still to be taken from files', () => {
    const keyed = { ...cmd, inputs: { files: ['src/**'] } }
    const nodes = new Map([node('make', [], cmd), node('use', ['make'], keyed)])
    expect([...trailable(nodes, none, all)]).toEqual(['use'])
    // Its key already taken: nothing of it reads this disk after `make`.
    expect([...trailable(nodes, (id) => id === 'use', all)].sort()).toEqual(['make', 'use'])
  })
})

describe('TrailingOutputs', () => {
  it('settles once each is here, and names the lost', async () => {
    const t = new TrailingOutputs()
    let here = false
    t.add(
      'a',
      Bun.sleep(20).then(() => void (here = true)),
    )
    t.add('b', Promise.reject(new Error('gone')))
    await t.settle()
    expect([here, t.lost]).toEqual([true, [{ id: 'b', message: 'gone' }]])
  })
})

for (const mode of ['trails', 'local dependant', 'lost'] as const) {
  it(
    {
      trails:
        'a dependant on another machine starts before the files are here, and the run waits for them',
      'local dependant':
        'CONTROL: with a dependant that runs here, the task is asked for its files first',
      lost: 'files that never come fail the run',
    }[mode],
    async () => {
      const root = await makeWorkspace({ prefix: 'vx-trailing-' })
      const said = path.join(root, 'said.log')
      try {
        const far = `{ executor() { return {
  name: 'far',
  capabilities: { remote: true },
  execute: async (req) => {
    const { appendFileSync, writeFileSync } = await import('node:fs')
    appendFileSync(${JSON.stringify(said)}, req.taskId + ' ' + (req.download ?? 'eager') + '\\n')
    const done = { exitCode: 0, durationMs: 1, stdout: '', stderr: '', violations: [] }
    if (!req.taskId.endsWith('#make')) return done
    const land = () => {
      writeFileSync(req.cwd + '/made.txt', 'M')
      appendFileSync(${JSON.stringify(said)}, 'landed\\n')
    }
    if (req.download !== 'trailing') return land(), done
    const landed = new Promise((ok, no) =>
      setTimeout(() => (${mode === 'lost'} ? no(new Error('the download failed')) : (land(), ok())), 300),
    )
    return { ...done, outputs: { kind: 'trailing', landed } }
  },
} } }`
        await Bun.write(
          path.join(root, '.vx/workspace.mjs'),
          localWorkspaceSource([pluginSource('org/far', far)]),
        )
        await addProject(root, 'tools', {
          config: `export default { tasks: { make: { exec: { command: 'true' } } } }`,
        })
        const here = mode === 'local dependant' ? `, remote: false` : ''
        await addProject(root, 'app', {
          config: `export default { tasks: { use: { exec: { command: 'true'${here} }, dependsOn: ['tools#make'] } } }`,
        })
        const p = Bun.spawnSync({
          cmd: [
            process.execPath,
            path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts'),
            'run',
            'use',
            '--all',
          ],
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, NO_COLOR: '1', CI: '' },
        })
        const out = p.stdout.toString() + p.stderr.toString()
        const lines = readFileSync(said, 'utf8').trim().split('\n')
        const made = existsSync(path.join(root, 'packages/tools/made.txt'))
        if (mode === 'trails') {
          expect([p.exitCode, out]).toEqual([0, expect.any(String)])
          expect([lines, made]).toEqual([
            ['tools#make trailing', 'app#use trailing', 'landed'],
            true,
          ])
        } else if (mode === 'local dependant') {
          expect([p.exitCode, out]).toEqual([0, expect.any(String)])
          expect(lines).toEqual(['tools#make eager', 'landed'])
        } else {
          expect([p.exitCode, lines]).toEqual([1, ['tools#make trailing', 'app#use trailing']])
          expect(out).toContain(
            'tools#make ran, and its files did not come back to this machine: the download failed',
          )
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000,
  )
}
