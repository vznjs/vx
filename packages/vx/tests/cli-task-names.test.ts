// Task names with colons, a config that awaits at its top level, `vx show`
// of a task needing a server, `--help` wherever it sits, a git worktree
// checked out inside the workspace, and a plugin that throws as it loads:
// each held by a probe once, now by a run.
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { dry, PARITY_TIMEOUT as TIMEOUT, vx } from './helpers/parity.js'

const cached = (command: string, extra = '') =>
  `{ exec: { command: ${JSON.stringify(command)} }, ${extra} inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } }`

describe('task names, configs and help', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-task-names-', edges: { a: ['b'] } })
    await addProject(root, 'b', {
      config: `export default { tasks: { 'build:prod': ${cached('echo b-prod')} } }\n`,
      files: { 'src/in.txt': 'b1\n' },
    })
    await addProject(root, 'a', {
      config: `const { word } = await import('./helper.mjs')
export default {
  tasks: {
    'build:prod': ${cached('echo a-prod', "dependsOn: ['^build:prod'],").replace(
      "inputs: { files: ['src/**'] }",
      "inputs: { files: ['src/**'], tasks: ['^build:prod'] }",
    )},
    'lint:fix': ${cached('echo lint-fix-ran')},
    'a:b:c': ${cached('echo abc-ran')},
    tla: { exec: { command: 'echo ' + word }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } },
    lint: ${cached('echo lint')},
    s1: { exec: { command: 'sleep 30', persistent: {} } },
    both: { dependsOn: ['s1', 'build:prod'] },
  },
}
`,
      files: { 'src/in.txt': 'a1\n', 'helper.mjs': "export const word = 'tla-ok'\n" },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    expect((await vx(root, ['lock'])).code).toBe(0)
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a colon task runs its ^dependency, and that dependency keys it',
    async () => {
      const before = await dry(root, ['a#build:prod'])
      expect(before.map((t) => t.id).sort()).toEqual(['a#build:prod', 'b#build:prod'])
      expect(before.find((t) => t.id === 'a#build:prod')!.deps).toEqual(['b#build:prod'])
      await writeFile(path.join(root, 'packages', 'b', 'src', 'in.txt'), 'b2\n')
      const after = await dry(root, ['a#build:prod'])
      const key = (ts: typeof before) => ts.find((t) => t.id === 'a#build:prod')!.hash
      expect(key(after)).not.toBe(key(before))
      await writeFile(path.join(root, 'packages', 'b', 'src', 'in.txt'), 'b1\n')
    },
    TIMEOUT,
  )

  it(
    'a#lint:fix, a#a:b:c, and lint:fix from the project directory each run their own task',
    async () => {
      const fix = await vx(root, ['run', 'a#lint:fix'])
      expect([fix.code, fix.out.includes('lint-fix-ran')]).toEqual([0, true])
      const abc = await vx(root, ['run', 'a#a:b:c'])
      expect([abc.code, abc.out.includes('abc-ran')]).toEqual([0, true])
      const fromDir = await vx(path.join(root, 'packages', 'a'), ['run', 'lint:fix'])
      expect([fromDir.code, fromDir.out.includes('lint-fix-ran')]).toEqual([0, true])
    },
    TIMEOUT,
  )

  it(
    'a config that awaits an import at its top level locks and runs',
    async () => {
      const r = await vx(root, ['run', 'a#tla'])
      expect([r.code, r.out.includes('tla-ok')]).toEqual([0, true])
    },
    TIMEOUT,
  )

  it(
    'vx show names every dependsOn of a task, the persistent one included',
    async () => {
      const r = await vx(root, ['show', 'a#both'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('s1')
      expect(r.out).toContain('build:prod')
    },
    TIMEOUT,
  )

  it(
    '--help prints the same text before, after or beside a task',
    async () => {
      const outs = await Promise.all(
        [
          ['run', '--help'],
          ['run', 'lint', '--help'],
          ['run', 'a#lint', '--help'],
        ].map((args) => vx(root, args)),
      )
      for (const r of outs) expect(r.code).toBe(0)
      expect(outs[0]!.out).toContain('vx run')
      expect(outs[1]!.out).toBe(outs[0]!.out)
      expect(outs[2]!.out).toBe(outs[0]!.out)
    },
    TIMEOUT,
  )

  it(
    'a git worktree checked out inside the workspace adds no project',
    async () => {
      const before = (await vx(root, ['show', '--format', 'json'])).out
      gitIn(root)('worktree', 'add', '-q', '--detach', path.join(root, '.wt'))
      try {
        expect((await vx(root, ['lock'])).code).toBe(0)
        expect((await vx(root, ['show', '--format', 'json'])).out).toBe(before)
      } finally {
        gitIn(root)('worktree', 'remove', '--force', path.join(root, '.wt'))
      }
    },
    TIMEOUT,
  )
})

it(
  'a plugin that throws as it loads names its error and file, for lock, run and show',
  async () => {
    const root = await makeWorkspace({ prefix: 'vx-plugin-throw-', workspaceFile: false })
    try {
      await mkdir(path.join(root, '.vx'), { recursive: true })
      await writeFile(path.join(root, '.vx', 'bad.mjs'), "throw new Error('BOOM-XYZ')\n")
      await writeFile(
        path.join(root, '.vx', 'workspace.mjs'),
        "import './bad.mjs'\nexport default {}\n",
      )
      for (const args of [['lock'], ['run', 'build', '--all'], ['show']]) {
        const r = await vx(root, args)
        expect({ args, code: r.code }).toEqual({ args, code: 1 })
        expect(r.err + r.out).toContain('BOOM-XYZ')
        expect(r.err + r.out).toContain('bad.mjs')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  TIMEOUT,
)
