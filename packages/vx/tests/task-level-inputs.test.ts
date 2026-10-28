// `inputs` sits on the task, not under `cache` (2026-10-16): a task
// is keyed on its inputs whether it caches or not, and a dependant folds
// that key, as Turbo and Nx hash every task. A task that runs a command and
// declares no inputs has no key: every dependant misses. Growth's parity
// repros (uncached-env-upstream.sh, uncached-input-upstream.sh) replayed a
// stale hit here: the uncached generator's env or root file never reached
// the cached reader's key.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { validateProjectConfig } from '../src/workspace/index.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-task-inputs-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await writeFile(path.join(root, rel), content)
}

function git(...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: [
      'git',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      ...args,
    ],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
}

/** `vx run b#build`, and what b's build printed. */
async function build(env: Record<string, string> = {}): Promise<string> {
  await rm(path.join(root, 'b', 'out.txt'), { force: true })
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, 'run', 'b#build'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1', ...env },
  })
  if (p.exitCode !== 0) throw new Error(p.stdout.toString() + p.stderr.toString())
  return (await readFile(path.join(root, 'b', 'out.txt'), 'utf8')).trim()
}

/** How many times b's build ran. */
async function runs(): Promise<number> {
  const log = await readFile(path.join(root, 'runs.log'), 'utf8').catch(() => '')
  return log.split('\n').filter((l) => l !== '').length
}

/** A generator `a#gen` writing b's gitignored input, and a cached `b#build` reading it. */
async function fixture(gen: string): Promise<void> {
  await write('.vx/workspace.mjs', 'export default {}\n')
  await write('.gitignore', 'out.txt\ngen.txt\nruns.log\n')
  await write('a/vx.config.mjs', `export default { name: 'a', tasks: { gen: ${gen} } }\n`)
  await write(
    'b/vx.config.mjs',
    `export default { name: 'b', tasks: { build: {
      dependsOn: ['a#gen'],
      exec: { command: 'cat src/gen.txt > out.txt && echo b >> ../runs.log' },
      inputs: { files: ['**/*'] },
      cache: { outputs: { files: ['out.txt'] } },
    } } }\n`,
  )
  await write('b/src/.keep', '')
  await write('shared/schema.txt', 'SCHEMA1\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
}

describe('an uncached task is keyed on its inputs', () => {
  it(
    'its `inputs.env` moves its cached dependant',
    async () => {
      await fixture(`{
        exec: { command: 'echo "api=$API_URL" > ../b/src/gen.txt', env: { passThrough: ['API_URL'] } },
        inputs: { files: [], env: ['API_URL'] },
      }`)
      expect(await build({ API_URL: 'one' })).toBe('api=one')
      expect(await build({ API_URL: 'two' })).toBe('api=two')
      // CONTROL: the same value keys alike, so the dependant hits.
      expect(await build({ API_URL: 'two' })).toBe('api=two')
      expect(await runs()).toBe(2)
    },
    TIMEOUT,
  )

  it(
    'its `inputs.workspaceFiles` moves its cached dependant',
    async () => {
      await fixture(`{
        exec: { command: 'cp ../shared/schema.txt ../b/src/gen.txt' },
        inputs: { files: [], workspaceFiles: ['shared/schema.txt'] },
      }`)
      expect(await build()).toBe('SCHEMA1')
      await write('shared/schema.txt', 'SCHEMA2\n')
      git('commit', '-qam', 's2')
      expect(await build()).toBe('SCHEMA2')
    },
    TIMEOUT,
  )

  it(
    'with empty inputs it is keyed on its config and deps, and its dependant hits',
    async () => {
      // Absent and empty differ (2026-10-16): `files: []` is a
      // declaration, so the key stands and a later run hits.
      await fixture(
        `{ exec: { command: 'cp ../shared/schema.txt ../b/src/gen.txt' }, inputs: { files: [] } }`,
      )
      expect(await build()).toBe('SCHEMA1')
      expect(await build()).toBe('SCHEMA1')
      expect(await runs()).toBe(1)
    },
    TIMEOUT,
  )

  it(
    'with no inputs it has no key, and its dependant never hits',
    async () => {
      await fixture(`{ exec: { command: 'cp ../shared/schema.txt ../b/src/gen.txt' } }`)
      expect(await build()).toBe('SCHEMA1')
      await write('shared/schema.txt', 'SCHEMA2\n')
      git('commit', '-qam', 's2')
      expect(await build()).toBe('SCHEMA2')
      // Nothing changed, and still no hit: the key is unknown, not unchanged.
      expect(await build()).toBe('SCHEMA2')
      expect(await runs()).toBe(3)
    },
    TIMEOUT,
  )
})

describe('a keyed group is a task with `inputs` and no command', () => {
  it(
    'its files move the dependant that folds it',
    async () => {
      await fixture(`{ inputs: { files: [], workspaceFiles: ['shared/schema.txt'] } }`)
      await write(
        'b/vx.config.mjs',
        `export default { name: 'b', tasks: { build: {
          dependsOn: ['a#gen'],
          exec: { command: 'cat ../shared/schema.txt > out.txt' },
          inputs: { files: ['src/**'] },
          cache: { outputs: { files: ['out.txt'] } },
        } } }\n`,
      )
      git('add', '-A')
      git('commit', '-qm', 'b')
      expect(await build()).toBe('SCHEMA1')
      await write('shared/schema.txt', 'SCHEMA2\n')
      git('commit', '-qam', 's2')
      expect(await build()).toBe('SCHEMA2')
    },
    TIMEOUT,
  )
})

describe('the schema', () => {
  const refusal = (task: object): string | null => {
    try {
      validateProjectConfig({ tasks: { t: task } } as never, 'p')
      return null
    } catch (err) {
      return (err as Error).message
    }
  }
  it('refuses `cache` without a command, and without inputs', () => {
    expect(
      refusal({ dependsOn: ['x'], inputs: { files: [] }, cache: { outputs: { files: [] } } }),
    ).toContain('`cache` needs `exec`')
    expect(refusal({ exec: { command: 'x' }, cache: { outputs: { files: [] } } })).toBe(
      "p: tasks.t: `cache` needs `inputs` — the key is the task's inputs, `inputs: { files: [...] }`",
    )
    // CONTROL: both spelled, and inputs alone, load.
    expect(
      refusal({ exec: { command: 'x' }, inputs: { files: [] }, cache: { outputs: { files: [] } } }),
    ).toBeNull()
    expect(refusal({ exec: { command: 'x' }, inputs: { files: ['src/**'] } })).toBeNull()
    expect(refusal({ inputs: { files: ['src/**'] } })).toBeNull()
  })

  it('refuses `inputs` under `cache`', () => {
    expect(
      refusal({ exec: { command: 'x' }, cache: { inputs: { files: [] }, outputs: { files: [] } } }),
    ).toContain('unknown field "inputs"')
  })
})
