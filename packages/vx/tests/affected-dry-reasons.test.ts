import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

const cached = (extra = '') => `export default {
  tasks: {
    build: {
      exec: { command: 'true' },${extra}
      inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } },
    },
    lint: { exec: { command: 'true' } },
  },
}
`

let root = ''

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-affected-why-', git: false, edges: { app: ['lib'] } })
  await addProject(root, 'lib', { config: cached(), files: { 'src/a.js': 'export {}\n' } })
  await addProject(root, 'app', {
    config: cached(`\n      dependsOn: ['^build'],`).replace(
      '    lint:',
      "    agg: { dependsOn: ['^build'] },\n    lint:",
    ),
    files: { 'src/a.js': 'export {}\n' },
  })
  await addProject(root, 'other', { config: cached(), files: { 'src/a.js': 'export {}\n' } })
  gitInitCommit(root)
  await writeFile(path.join(root, 'packages/lib/src/a.js'), 'export const a = 1\n')
})

afterAll(() => rm(root, { recursive: true, force: true }))

function dry(...args: string[]): string {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', ...args, '--affected=HEAD'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  expect([p.exitCode, p.stderr.toString()]).toEqual([0, ''])
  return p.stdout.toString()
}

describe('vx run --affected --dry says why each requested task was kept', () => {
  it('json: the changed input, the project read whole, the edge chain', () => {
    const plan = JSON.parse(dry('build', 'lint', '--dry=json')) as {
      affectedBase?: string
      tasks: Array<{ id: string; affected?: unknown }>
    }
    // The ref the diff was against, so a reason naming no file can be traced.
    expect(plan.affectedBase).toBe('HEAD')
    expect(Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))).toEqual({
      'lib#build': { kind: 'input', file: 'packages/lib/src/a.js' },
      'lib#lint': { kind: 'project', file: 'packages/lib/src/a.js' },
      'app#build': { kind: 'input', file: 'packages/lib/src/a.js', via: ['lib#build'] },
    })
  })

  it('json: beside a bare task, one named as pkg#task is kept because it was named', () => {
    const plan = JSON.parse(dry('lint', 'other#build', '--dry=json')) as {
      tasks: Array<{ id: string; affected?: unknown }>
    }
    expect(Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))).toEqual({
      'lib#lint': { kind: 'project', file: 'packages/lib/src/a.js' },
      'other#build': { kind: 'named' },
    })
  })

  it('json: a group whose dependency is affected is kept, through that edge', () => {
    // A task with no command of its own aggregates its dependencies: with
    // one of them affected, it must be selected too.
    const plan = JSON.parse(dry('agg', '--dry=json')) as {
      tasks: Array<{ id: string; affected?: { via?: string[] } }>
    }
    expect(plan.tasks.find((t) => t.id === 'app#agg')?.affected?.via).toEqual(['lib#build'])
  })

  it('CONTROL: a plan without --affected states no base', () => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'build', '--all', '--dry=json'],
      cwd: root,
    })
    expect(p.exitCode).toBe(0)
    expect(Object.keys(JSON.parse(p.stdout.toString()) as object)).not.toContain('affectedBase')
  })

  it('text: one reason line under each kept task', () => {
    const lines = dry('build', 'lint', '--dry')
      .split('\n')
      .filter((l) => l.includes('affected:'))
      .map((l) => l.trim())
    expect(lines.sort()).toEqual([
      'affected: packages/lib/src/a.js changed (an input)',
      'affected: packages/lib/src/a.js changed (an input), via lib#build',
      'affected: packages/lib/src/a.js changed (in its project)',
    ])
  })

  it('json: a path no cached task declares names itself on the whole project', async () => {
    // Agent trial 2, row 5: `kind: project` with no `file` sent the agent
    // looking for an input that had not changed; an unignored output had.
    const stray = path.join(root, 'packages/other/out.txt')
    await writeFile(stray, 'built\n')
    try {
      const plan = JSON.parse(dry('build', '--dry=json')) as {
        tasks: Array<{ id: string; affected?: unknown }>
      }
      expect(plan.tasks.find((t) => t.id === 'other#build')?.affected).toEqual({
        kind: 'project',
        file: 'packages/other/out.txt',
      })
    } finally {
      await rm(stray)
    }
  })

  it('json and text: a workspace-wide file names itself on every task it reached', async () => {
    // Agent trial 3, row 3: a changed workspace config made every task
    // `kind: project` with no `file`.
    const ws = path.join(root, '.vx/workspace.mjs')
    const before = await readFile(ws, 'utf8')
    await writeFile(ws, `${before}// edited\n`)
    try {
      const plan = JSON.parse(dry('build', '--dry=json')) as {
        tasks: Array<{ id: string; affected?: unknown }>
      }
      const reason = { kind: 'workspace', file: '.vx/workspace.mjs' }
      expect(Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))).toEqual({
        'lib#build': reason,
        'app#build': reason,
        'other#build': reason,
      })
      expect(dry('build', '--filter', 'other', '--dry')).toContain(
        'affected: .vx/workspace.mjs changed (workspace-wide)',
      )
    } finally {
      await writeFile(ws, before)
    }
  })
})
