import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { edgesSource, pluginSource } from './helpers/plugin.js'
import { addProject, gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

const cached = (extra = '') => `export default {
  tasks: {
    build: {
      exec: { command: 'true' },${extra}
      inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true,
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
  await addProject(root, 'gen', {
    config: `export default {
  tasks: {
    build: {
      exec: { command: 'true' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true,
    },
    test: { exec: { command: 'true' }, inputs: { files: ['test/**'] }, outputs: { files: [] }, cache: true },
  },
}
`,
    files: { 'src/a.js': 'export {}\n', 'dist/committed.js': 'export {}\n' },
  })
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

  it("text: each kept task's row says why, after its id", () => {
    const lines = dry('build', 'lint', '--dry')
      .split('\n')
      .filter((l) => l.includes('affected:'))
      .map((l) => l.slice(l.lastIndexOf(' ', l.indexOf('  affected:') - 1) + 1))
    expect(lines.sort()).toEqual([
      'app#build  affected: packages/lib/src/a.js changed (an input), via lib#build',
      'lib#build  affected: packages/lib/src/a.js changed (an input)',
      'lib#lint  affected: packages/lib/src/a.js changed (in its project)',
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

  it('an untracked file under its own outputs is no input: the project is read whole', async () => {
    // The key folds a file under a task's own outputs only when git tracks
    // it; an untracked build output git does not ignore was still labelled
    // `changed (an input)` and kept only the task whose outputs held it.
    const built = path.join(root, 'packages/gen/dist/o.js')
    await writeFile(built, 'built\n')
    try {
      const plan = JSON.parse(dry('build', 'test', '--dry=json')) as {
        tasks: Array<{ id: string; affected?: unknown }>
      }
      const reason = { kind: 'project', file: 'packages/gen/dist/o.js' }
      expect(Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))).toMatchObject({
        'gen#build': reason,
        'gen#test': reason,
      })
      expect(dry('build', '--dry')).toContain(
        'gen#build  affected: packages/gen/dist/o.js changed (in its project)',
      )
    } finally {
      await rm(built)
    }
  })

  it('CONTROL: a committed file under its own outputs that changed is an input', async () => {
    const committed = path.join(root, 'packages/gen/dist/committed.js')
    const before = await readFile(committed, 'utf8')
    await writeFile(committed, 'export const changed = 1\n')
    try {
      const plan = JSON.parse(dry('build', 'test', '--dry=json')) as {
        tasks: Array<{ id: string; affected?: unknown }>
      }
      const kept = Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))
      expect(kept['gen#build']).toEqual({ kind: 'input', file: 'packages/gen/dist/committed.js' })
      expect(kept['gen#test']).toBeUndefined()
    } finally {
      await writeFile(committed, before)
    }
  })

  it('text: a control character in a changed file name is escaped, not printed raw', async () => {
    // A newline in the name broke the `affected:` line in two.
    const odd = path.join(root, 'packages/other/src/x\ny.js')
    await writeFile(odd, 'export {}\n')
    try {
      expect(dry('build', '--dry')).toContain(
        'affected: packages/other/src/x\\x0ay.js changed (an input)',
      )
    } finally {
      await rm(odd)
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
        'gen#build': reason,
      })
      expect(dry('build', '--filter', 'other', '--dry')).toContain(
        'affected: .vx/workspace.mjs changed (workspace-wide)',
      )
    } finally {
      await writeFile(ws, before)
    }
  })

  it('text: a claimed root file that reached some projects says so, not workspace-wide', async () => {
    // A lockfile claim names the projects whose digest moved; the label
    // said "(workspace-wide)" of a change that reached one project.
    const ws = await makeWorkspace({ prefix: 'vx-affected-claim-', git: false })
    try {
      await Bun.write(
        path.join(ws, '.vx/workspace.mjs'),
        localWorkspaceSource([
          edgesSource(),
          pluginSource(
            'org/pm',
            `{ fingerprint: { files: ['pnpm-lock.yaml'], affected: () => ['b'] }, key() { return undefined } }`,
          ),
        ]),
      )
      await addProject(ws, 'a', { config: cached(), files: { 'src/a.js': 'export {}\n' } })
      await addProject(ws, 'b', { config: cached(), files: { 'src/a.js': 'export {}\n' } })
      await writeFile(path.join(ws, 'pnpm-lock.yaml'), 'v1\n')
      gitInitCommit(ws)
      await writeFile(path.join(ws, 'pnpm-lock.yaml'), 'v2\n')
      const p = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', 'build', '--affected=HEAD', '--dry'],
        cwd: ws,
        env: { ...process.env, NO_COLOR: '1' },
      })
      expect([p.exitCode, p.stderr.toString()]).toEqual([0, ''])
      expect(p.stdout.toString()).toContain(
        'b#build  affected: pnpm-lock.yaml changed (every task in its project)',
      )
      expect(p.stdout.toString()).not.toContain('a#build')
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})

describe("vx run --affected: a path under a task's own outputs, by its workspaceFiles", () => {
  // The key folds a path under the task's own outputs (`workspaceFiles`, or
  // `files` a root-anchored glob reaches) only when git tracks it;
  // `inputs.workspaceFiles` matched an untracked one there and kept the
  // task as `input`.
  let ws = ''
  beforeAll(async () => {
    ws = await makeWorkspace({ prefix: 'vx-affected-wsout-', git: false })
    await addProject(ws, 'cg', {
      config: `export default {
  tasks: {
    gen: {
      exec: { command: 'true' },
      inputs: { files: ['src/**'], workspaceFiles: ['shared/**', 'packages/cg/**'] },
      outputs: { files: ['dist/**'], workspaceFiles: ['shared/gen/**'] },
      cache: true,
    },
  },
}
`,
      files: { 'src/a.js': 'export {}\n', 'dist/committed.js': 'export {}\n' },
    })
    await Bun.write(path.join(ws, 'shared/a.txt'), 'a\n')
    await Bun.write(path.join(ws, 'shared/gen/committed.txt'), 'c\n')
    gitInitCommit(ws)
  })
  afterAll(() => rm(ws, { recursive: true, force: true }))

  const plan = () =>
    Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'gen', '--affected=HEAD', '--dry=json'],
      cwd: ws,
      env: { ...process.env, NO_COLOR: '1' },
    })

  const kept = (): Record<string, unknown> => {
    const p = plan()
    expect([p.exitCode, p.stderr.toString()]).toEqual([0, ''])
    const { tasks } = JSON.parse(p.stdout.toString()) as {
      tasks: Array<{ id: string; affected?: unknown }>
    }
    return Object.fromEntries(tasks.map((t) => [t.id, t.affected]))
  }

  const withFile = async (rel: string, body: string, check: () => void): Promise<void> => {
    const abs = path.join(ws, rel)
    const before = await readFile(abs, 'utf8').catch(() => null)
    await Bun.write(abs, body)
    try {
      check()
    } finally {
      if (before === null) await rm(abs)
      else await writeFile(abs, before)
    }
  }

  it('an untracked file under its own outputs.workspaceFiles is no input', () =>
    withFile('shared/gen/o.txt', 'built\n', () => {
      const p = plan()
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('cg#gen')
      expect(p.stderr.toString()).toContain('nothing affected since HEAD')
    }))

  it('an untracked file under its own outputs.files that a workspaceFiles glob reaches is no input', () =>
    withFile('packages/cg/dist/o.js', 'built\n', () => {
      // No task declares it, so the project is read whole, as for `files`.
      expect(kept()['cg#gen']).toEqual({ kind: 'project', file: 'packages/cg/dist/o.js' })
    }))

  it('CONTROL: a tracked file under its own outputs.workspaceFiles that changed is an input', () =>
    withFile('shared/gen/committed.txt', 'changed\n', () => {
      expect(kept()['cg#gen']).toEqual({ kind: 'input', file: 'shared/gen/committed.txt' })
    }))

  it('CONTROL: a file under its own outputs.workspaceFiles git stopped tracking is an input', () => {
    // Untracked now, but the base key folded it: the key moved.
    const g = gitIn(ws)
    g('rm', '-q', '--cached', 'shared/gen/committed.txt')
    try {
      expect(kept()['cg#gen']).toEqual({ kind: 'input', file: 'shared/gen/committed.txt' })
    } finally {
      g('add', 'shared/gen/committed.txt')
    }
  })

  it('CONTROL: an untracked file its workspaceFiles glob reaches outside its outputs is an input', () =>
    withFile('shared/b.txt', 'b\n', () => {
      expect(kept()['cg#gen']).toEqual({ kind: 'input', file: 'shared/b.txt' })
    }))
})
