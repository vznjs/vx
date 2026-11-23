// `vx pipeline <name>` runs a `vx run` saved in `.vx/workspace` (M,
// 2026-11-22): its tasks in every project, each key its flag, a typed flag
// or the flag's variable over the saved value, and its `env` for vx alone.
import { existsSync } from 'node:fs'
import { realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { Pipeline, WorkspaceConfig } from '../src/config.js'
import { acceptedFlags } from '../src/cli/help.js'
import { PIPELINE_FLAGS, pipelineRunArgs, validateWorkspace } from '../src/workspace/index.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

const refusal = (pipelines: unknown): string | undefined => {
  try {
    validateWorkspace({ pipelines } as WorkspaceConfig, 'ws.ts')
    return undefined
  } catch (err) {
    return (err as Error).message
  }
}

describe('pipelines in .vx/workspace', () => {
  it('takes every vx run flag but --all as a key', () => {
    const keyFlags = Object.values(PIPELINE_FLAGS).map((f) => f.flag)
    const runFlags = acceptedFlags('run').filter((f) => !['--all', '--help'].includes(f))
    expect(keyFlags.sort()).toEqual(runFlags.sort())
    expect(acceptedFlags('pipeline')).not.toContain('--all')
  })

  it('holds each key to its flag, naming the file and the key', () => {
    expect(refusal({ pr: { tasks: ['lint'], concurrency: 2, affected: true } })).toBeUndefined()
    expect(refusal({ pr: { tasks: [] } })).toBe(
      "ws.ts: `pipelines.pr.tasks` must be a non-empty array of task names, like ['lint', 'test']",
    )
    expect(refusal({ pr: { tasks: ['a'], all: true } })).toContain('`pipelines.pr`')
    expect(refusal({ pr: { tasks: ['a'], concurrency: 0 } })).toContain(
      '`pipelines.pr.concurrency`',
    )
    expect(refusal({ pr: { tasks: ['a'], failFast: 'sometimes' } })).toContain(
      '`pipelines.pr.failFast`',
    )
    expect(refusal({ pr: { tasks: ['a'], env: { A: 1 } } })).toContain('`pipelines.pr.env`')
    expect(refusal({ pr: { tasks: ['a'], dry: 'yaml' } })).toContain('`pipelines.pr.dry`')
    expect(refusal({ pr: { tasks: ['a'], dry: true, profile: true } })).toBe(
      'ws.ts: `pipelines.pr` sets dry and profile: a dry run writes no profile; drop one',
    )
    expect(refusal({ 'p r': { tasks: ['a'] } })).toContain('pipeline name "p r"')
    // A name no task can carry: `--force` was read as the flag and refused
    // as "vx run missing task name", `^build` at the run.
    expect(refusal({ pr: { tasks: ['--force'] } })).toBe(
      "ws.ts: `pipelines.pr.tasks` names \"--force\": it starts with '-', which the CLI reads as a flag; name a task, or 'pkg#task'",
    )
    for (const bad of [
      '^build',
      'a#',
      '#build',
      'a#^b',
      'build ',
      'b*',
      '--force#build',
      'a #b',
      '^a#b',
    ])
      expect(refusal({ pr: { tasks: [bad] } })).toContain('`pipelines.pr.tasks` names')
    expect(refusal({ pr: { tasks: ['build', 'a#build', '@s/a#test'] } })).toBeUndefined()
    // Its `env` and a key both setting one setting: the variable silently won.
    expect(refusal({ pr: { tasks: ['a'], retries: 1, env: { VX_RUN_RETRIES: '2' } } })).toBe(
      'ws.ts: `pipelines.pr.env.VX_RUN_RETRIES` sets what `pipelines.pr.retries` sets: drop one',
    )
    expect(refusal({ pr: { tasks: ['a'], env: { VX_RUN_RETRIES: '2' } } })).toBeUndefined()
    // A key that saves no flag, or a value that sets nothing, is no second say.
    expect(
      refusal({ pr: { tasks: ['a'], failFast: false, env: { VX_RUN_FAIL_FAST: 'true' } } }),
    ).toBeUndefined()
    expect(
      refusal({ pr: { tasks: ['a'], retries: 1, env: { VX_RUN_RETRIES: '' } } }),
    ).toBeUndefined()
    expect(refusal(['pr'])).toContain('`pipelines` must be an object')
  })

  it('is the vx run line it saves; a typed flag or its variable beats a key', () => {
    const p: Pipeline = {
      tasks: ['lint', 'test'],
      filter: ['a', 'b'],
      affected: true,
      excludeDependencies: ['gen'],
      concurrency: '50%',
      failFast: true,
      noCache: false,
      profile: 'p.json',
    }
    expect(pipelineRunArgs(p, [], {})).toEqual([
      'lint',
      'test',
      '--all',
      '--filter=a',
      '--filter=b',
      '--affected',
      '--exclude-dependencies=gen',
      '--concurrency=50%',
      '--fail-fast',
      '--profile=p.json',
    ])
    const typed = pipelineRunArgs(p, ['--fail-fast', '--filter', 'c'], {
      VX_RUN_CONCURRENCY: '2',
    })
    expect(typed).toEqual([
      'lint',
      'test',
      '--all',
      '--affected',
      '--exclude-dependencies=gen',
      '--profile=p.json',
    ])
    // A typed --dry previews it: the saved profile needs a real run.
    expect(pipelineRunArgs({ tasks: ['a'], profile: true }, ['--dry'], {})).toEqual(['a', '--all'])
    expect(pipelineRunArgs({ tasks: ['a'], dry: true }, ['--profile'], {})).toEqual(['a', '--all'])
    // A run applies --no-cache over every cache policy and --force over the
    // policy's reads, so a typed policy or --force (or the policy's variable)
    // stands in for a saved noCache, and a typed policy for a saved force.
    const nc: Pipeline = { tasks: ['a'], noCache: true, force: true }
    expect(pipelineRunArgs(nc, ['--cache-policy=local:rw'], {})).toEqual(['a', '--all'])
    expect(pipelineRunArgs(nc, [], { VX_CACHE_POLICY: 'local:rw' })).toEqual(['a', '--all'])
    expect(pipelineRunArgs(nc, ['--force'], {})).toEqual(['a', '--all'])
    // CONTROL: untyped, both stay.
    expect(pipelineRunArgs(nc, [], {})).toEqual(['a', '--all', '--no-cache', '--force'])
  })
})

describe('vx pipeline <name>', () => {
  let root = ''
  let cwd = ''
  const vx = async (...args: string[]): Promise<{ code: number; out: string; err: string }> => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: cwd || root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1', SHOWN: '' },
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, out, err }
  }
  const planned = async (...args: string[]): Promise<string[]> => {
    const r = await vx('pipeline', ...args, '--dry=json')
    expect(r.err).toBe('')
    return (JSON.parse(r.out) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort()
  }

  beforeAll(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-pipeline-' }))
    await writeFile(
      path.join(root, '.vx/workspace.mjs'),
      localWorkspaceSource(
        [],
        '',
        undefined,
        `pipelines: {
          check: { tasks: ['build'] },
          one: { tasks: ['build'], filter: ['a'] },
          env: { tasks: ['show'], filter: ['a'], env: { SHOWN: 'vx-only' } },
          quiet: { tasks: ['show'], filter: ['a'], env: { VX_RUN_OUTPUT_LOGS: 'none' } },
          ghost: { tasks: ['nope'] },
          paths: { tasks: ['keep'], filter: ['a'], cacheDir: 'saved-cache', profile: 'saved.json' },
          policy: { tasks: ['build'], cachePolicy: 'bogus' },
          badenv: { tasks: ['build'], env: { VX_RUN_RETRIES: 'x', VX_CACHE_POLICY: 'local:q' } },
          own: { tasks: ['keep'], filter: ['a'], noCache: true, env: { VX_CACHE_POLICY: 'local:rw' } },
          base: { tasks: ['build'], affected: true },
        }`,
      ),
    )
    for (const name of ['a', 'b'])
      await addProject(
        root,
        name,
        `export default { tasks: {
          build: { exec: { command: 'true' } },
          show: { exec: { command: 'echo "shown=[$SHOWN]"', env: { passThrough: ['SHOWN'] } } },
          keep: { exec: { command: 'echo k > k.txt' }, inputs: { files: ['package.json'] }, outputs: { files: ['k.txt'] }, cache: true },
        } }`,
      )
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs its tasks in every project, or in those its filter names', async () => {
    expect(await planned('check')).toEqual(['a#build', 'b#build'])
    expect(await planned('one')).toEqual(['a#build'])
    // A typed flag beats the saved one.
    expect(await planned('one', '--filter', 'b')).toEqual(['b#build'])
  }, 30_000)

  it('sets its env for vx, and a task reads it as unset', async () => {
    const shown = await vx('pipeline', 'env', '--output-logs=full')
    expect([shown.code, shown.out]).toEqual([0, expect.stringContaining('shown=[]')])
    // vx itself reads it: the run's output is off.
    const quiet = await vx('pipeline', 'quiet')
    expect([quiet.code, quiet.out.includes('shown=')]).toEqual([0, false])
  }, 30_000)

  // A path in the workspace file stands from the root, as `cache.dir` there
  // does: run from a project's directory, it made a second cache inside it.
  it('reads its paths from the workspace root, wherever it runs', async () => {
    cwd = path.join(root, 'packages', 'a')
    // The suite's own VX_CACHE_DIR would beat the key.
    const dir = process.env['VX_CACHE_DIR']
    process.env['VX_CACHE_DIR'] = ''
    try {
      const r = await vx('pipeline', 'paths')
      expect([r.code, r.err]).toEqual([0, ''])
    } finally {
      cwd = ''
      if (dir === undefined) delete process.env['VX_CACHE_DIR']
      else process.env['VX_CACHE_DIR'] = dir
    }
    expect(existsSync(path.join(root, 'saved-cache'))).toBe(true)
    expect(existsSync(path.join(root, 'saved.json'))).toBe(true)
    expect(existsSync(path.join(root, 'packages', 'a', 'saved-cache'))).toBe(false)
    expect(existsSync(path.join(root, 'packages', 'a', 'saved.json'))).toBe(false)
  }, 30_000)

  // The load cannot check these; the run's parser refused them as a typed
  // `--cache-policy` under `vx run`, or as a variable the user never set.
  it('refuses a bad saved cachePolicy or setting variable, naming its key', async () => {
    const policy = await vx('pipeline', 'policy')
    expect([policy.code, policy.err]).toEqual([
      1,
      expect.stringContaining("`pipelines.policy.cachePolicy` invalid segment 'bogus'"),
    ])
    expect(policy.err).not.toContain('--cache-policy')
    const env = await vx('pipeline', 'badenv')
    expect([env.code, env.err]).toEqual([
      1,
      expect.stringContaining('`pipelines.badenv.env.VX_RUN_RETRIES` must be a non-negative'),
    ])
    // Its flag beats the variable, so nothing reads it; the next one is read.
    const typed = await vx('pipeline', 'badenv', '--retries=0')
    expect(typed.err).toContain("`pipelines.badenv.env.VX_CACHE_POLICY` invalid flag 'q'")
    const both = await vx('pipeline', 'badenv', '--retries=0', '--cache-policy=local:rw')
    expect([both.code, both.err]).toEqual([0, ''])
  }, 30_000)

  // Its own `env` is saved as its keys are: its policy variable dropped its
  // `noCache`, as only a typed one (or one already set) should.
  it('keeps a saved key over its own env', async () => {
    const dir = process.env['VX_CACHE_DIR']
    process.env['VX_CACHE_DIR'] = path.join(root, 'own-cache')
    try {
      expect((await vx('pipeline', 'own')).code).toBe(0)
      const r = await vx('pipeline', 'own', '--dry=json')
      expect(r.err).toBe('')
      const plan = JSON.parse(r.out) as { tasks: { cacheStatus: string }[] }
      expect(plan.tasks.map((t) => t.cacheStatus)).toEqual(['no-cache'])
    } finally {
      if (dir === undefined) delete process.env['VX_CACHE_DIR']
      else process.env['VX_CACHE_DIR'] = dir
    }
  }, 30_000)

  // `--affected` was never typed: the refusal said to drop it.
  it('names the key behind a refused saved flag', async () => {
    const r = await vx('pipeline', 'base')
    expect([r.code, r.err]).toEqual([1, expect.stringContaining('--affected has no base here')])
    expect(r.err).toContain('--affected is `pipelines.base.affected` in .vx/workspace\n')
    const typed = await vx('pipeline', 'check', '--affected')
    expect(typed.err).toContain('--affected has no base here')
    expect(typed.err).not.toContain('`pipelines.')
  }, 30_000)

  it('refuses no name, an unknown one, a task and --all, naming the fix', async () => {
    expect((await vx('pipeline')).err).toContain('missing pipeline name')
    const typo = (await vx('pipeline', 'chek')).err
    expect(typo).toContain(
      'no pipeline named chek; pipelines: check, one, env, quiet, ghost, paths',
    )
    expect(typo).toContain('fix  vx pipeline check')
    expect((await vx('pipeline', 'check', 'lint')).err).toContain(
      'vx pipeline runs one pipeline, whose tasks are its `tasks` (got lint)',
    )
    expect((await vx('pipeline', 'check', '--all')).err).toContain(
      '--all: a pipeline runs every project already',
    )
    expect((await vx('pipeline', 'check', '--', 'x')).err).toContain('forwards nothing after --')
    // A refusal past the flags is the pipeline's, not the `vx run` it stands for.
    const ghost = (await vx('pipeline', 'ghost')).err
    expect(ghost).toContain('vx pipeline  no projects declare task(s): nope')
    expect(ghost).not.toContain('vx run ')
    // A name the object's prototype holds is no pipeline: it was taken for
    // one and crashed with a stack.
    for (const name of ['constructor', '__proto__', 'toString']) {
      const r = await vx('pipeline', name)
      expect([r.code, r.err]).toEqual([1, expect.stringContaining(`no pipeline named ${name}`)])
    }
  }, 30_000)
})
