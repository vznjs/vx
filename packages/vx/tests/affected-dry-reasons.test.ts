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
  it('json: the changed input, a task with no inputs, the edge chain', () => {
    const plan = JSON.parse(dry('build', 'lint', '--dry', '--format', 'json')) as {
      affectedBase?: string
      tasks: Array<{ id: string; affected?: unknown }>
    }
    // The ref the diff was against, so a reason naming no file can be traced.
    expect(plan.affectedBase).toBe('HEAD')
    expect(Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))).toEqual({
      'lib#build': { kind: 'input', file: 'packages/lib/src/a.js' },
      // No inputs: affected in a changed project (lib) and in a package
      // dependant of one (app), never elsewhere (other) (M, 2026-11-25).
      'lib#lint': { kind: 'always' },
      'app#lint': { kind: 'always' },
      'app#build': { kind: 'input', file: 'packages/lib/src/a.js', via: ['lib#build'] },
    })
  })

  it('json: beside a bare task, one named as pkg#task is kept because it was named', () => {
    const plan = JSON.parse(dry('lint', 'other#build', '--dry', '--format', 'json')) as {
      tasks: Array<{ id: string; affected?: unknown }>
    }
    expect(Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))).toEqual({
      'lib#lint': { kind: 'always' },
      'app#lint': { kind: 'always' },
      'other#build': { kind: 'named' },
    })
  })

  it('json: a group whose dependency is affected is kept, through that edge', () => {
    // A task with no command of its own aggregates its dependencies: with
    // one of them affected, it must be selected too.
    const plan = JSON.parse(dry('agg', '--dry', '--format', 'json')) as {
      tasks: Array<{ id: string; affected?: { via?: string[] } }>
    }
    expect(plan.tasks.find((t) => t.id === 'app#agg')?.affected?.via).toEqual(['lib#build'])
  })

  it('CONTROL: a plan without --affected states no base', () => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'build', '--all', '--dry', '--format', 'json'],
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
      'app#lint  affected: it declares no inputs, and its project changed or depends on one that did',
      'lib#build  affected: packages/lib/src/a.js changed (an input)',
      'lib#lint  affected: it declares no inputs, and its project changed or depends on one that did',
    ])
  })

  it('a changed path no input declares reaches no task with inputs', async () => {
    // Its project was read whole, so an unignored output re-ran every task
    // there (M, 2026-11-25: affected is decided by inputs).
    const stray = path.join(root, 'packages/other/out.txt')
    const built = path.join(root, 'packages/gen/dist/o.js')
    await writeFile(stray, 'built\n')
    await writeFile(built, 'built\n')
    try {
      const plan = JSON.parse(dry('build', 'test', '--dry', '--format', 'json')) as {
        tasks: Array<{ id: string; affected?: unknown }>
      }
      const kept = Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))
      expect(kept['other#build']).toBeUndefined()
      // An untracked file under its own outputs is no input either.
      expect(kept['gen#build']).toBeUndefined()
      expect(kept['gen#test']).toBeUndefined()
    } finally {
      await rm(stray)
      await rm(built)
    }
  })

  it('CONTROL: a committed file under its own outputs that changed is an input', async () => {
    const committed = path.join(root, 'packages/gen/dist/committed.js')
    const before = await readFile(committed, 'utf8')
    await writeFile(committed, 'export const changed = 1\n')
    try {
      const plan = JSON.parse(dry('build', 'test', '--dry', '--format', 'json')) as {
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

  it('a workspace config edit that moves no key reaches no task with inputs', async () => {
    // Agent trial 3, row 3 marked every task; a comment moves no locked
    // config, and no plugin here keys tasks (M, 2026-11-25).
    const ws = path.join(root, '.vx/workspace.mjs')
    const before = await readFile(ws, 'utf8')
    await writeFile(ws, `${before}// edited\n`)
    try {
      const plan = JSON.parse(dry('build', 'lint', '--dry', '--format', 'json')) as {
        tasks: Array<{ id: string; affected?: { kind: string } }>
      }
      const kept = plan.tasks.filter((t) => t.affected !== undefined)
      expect(kept.map((t) => t.affected!.kind)).not.toContain('workspace')
      expect(kept.map((t) => t.id)).not.toContain('other#build')
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
        'b#build  affected: pnpm-lock.yaml changed (in its key)',
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
      cmd: [process.execPath, BIN, 'run', 'gen', '--affected=HEAD', '--dry', '--format', 'json'],
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
      expect(p.stderr.toString()).toContain('Nothing affected: the change reaches no gen task')
    }))

  it('an untracked file under its own outputs.files that a workspaceFiles glob reaches is no input', () =>
    withFile('packages/cg/dist/o.js', 'built\n', () => {
      // No task declares it, so it reaches no task (M, 2026-11-25).
      const p = plan()
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('cg#gen')
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

// Only the locks mark tasks (M, 2026-11-25): a project's closure digest
// that moved in `.vx/dependencies.lock` marks its tasks, and no other
// project's, though the claimant answers no project from the file.
it('a dependencies.lock closure change marks only the tasks of the projects it moved', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-affected-closure-', git: false })
  try {
    const claim = `{ fingerprint: {
      files: ['deps.txt'],
      affected: () => [],
      digests(file, ctx) {
        const text = require('node:fs').readFileSync(require('node:path').join(ctx.workspaceRoot, file), 'utf8')
        const projects = Object.fromEntries(text.trim().split('\\n').map((l) => l.split('=')))
        return { hash: String(Bun.hash.xxHash3(text)), projects }
      },
    }, key() { return undefined } }`
    await Bun.write(
      path.join(ws, '.vx/workspace.mjs'),
      localWorkspaceSource([edgesSource(), pluginSource('org/closure', claim)]),
    )
    await addProject(ws, 'a', { config: cached(), files: { 'src/a.js': 'export {}\n' } })
    await addProject(ws, 'b', { config: cached(), files: { 'src/a.js': 'export {}\n' } })
    const lock = (): void => {
      const r = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws })
      expect([r.exitCode, r.stderr.toString()]).toEqual([0, ''])
    }
    await writeFile(path.join(ws, 'deps.txt'), 'a=00aa\nb=00bb\n')
    lock()
    gitInitCommit(ws)
    await writeFile(path.join(ws, 'deps.txt'), 'a=00aa\nb=11bb\n')
    lock()
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'build', '--affected=HEAD', '--dry', '--format', 'json'],
      cwd: ws,
      env: { ...process.env, NO_COLOR: '1' },
    })
    expect([p.exitCode, p.stderr.toString()]).toEqual([0, ''])
    const plan = JSON.parse(p.stdout.toString()) as {
      tasks: Array<{ id: string; affected?: unknown }>
    }
    expect(Object.fromEntries(plan.tasks.map((t) => [t.id, t.affected]))).toEqual({
      'b#build': { kind: 'workspace', file: '.vx/dependencies.lock' },
    })
  } finally {
    await rm(ws, { recursive: true, force: true })
  }
})
