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
import { addProject, git, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const LOCK_BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

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
    // M 2026-11-23: the plan's format is its own key, as `--format` is.
    expect(refusal({ pr: { tasks: ['a'], dry: 'json' } })).toContain('`pipelines.pr.dry`')
    expect(refusal({ pr: { tasks: ['a'], dry: true, format: 'json' } })).toBeUndefined()
    expect(refusal({ pr: { tasks: ['a'], format: 'json' } })).toBe(
      'ws.ts: `pipelines.pr.format` formats the plan, so it needs dry: true',
    )
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
    const plan: Pipeline = { tasks: ['a'], dry: true, format: 'json' }
    expect(pipelineRunArgs(plan, [], {})).toEqual(['a', '--all', '--dry', '--format=json'])
    expect(pipelineRunArgs(plan, ['--profile'], {})).toEqual(['a', '--all'])
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

// A typo in a pipeline's task waited for the CI job that ran it: the lock,
// which reads every task, names it.
it('vx lock refuses a pipeline task no project declares', async () => {
  const root = await realpath(await makeWorkspace({ prefix: 'vx-pipeline-ghost-' }))
  try {
    await addProject(root, 'a', `export default { tasks: { lint: { exec: { command: 'true' } } } }`)
    const lock = async (tasks: string): Promise<{ code: number; err: string }> => {
      await writeFile(
        path.join(root, '.vx/workspace.mjs'),
        localWorkspaceSource([], '', undefined, `pipelines: { pr: { tasks: ${tasks} } }`),
      )
      const p = Bun.spawnSync([process.execPath, LOCK_BIN, 'lock'], {
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
      })
      return { code: p.exitCode, err: p.stderr.toString() + p.stdout.toString() }
    }
    expect(await lock(`['lint', 'nope', 'a#lnt']`)).toEqual({
      code: 1,
      err: expect.stringContaining(
        'pipelines.pr.tasks names nope, a#lnt, which no project declares; tasks: lint',
      ),
    })
    // Every project's default build counts, as a run takes it.
    expect((await lock(`['lint', 'a#lint', 'build', 'a#build']`)).code).toBe(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

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
    const r = await vx('pipeline', ...args, '--dry', '--format', 'json')
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
          env: { tasks: ['show', 'probe'], filter: ['a'], env: { SHOWN: 'vx-only', CI: 'vx-only' } },
          quiet: { tasks: ['show'], filter: ['a'], env: { VX_RUN_OUTPUT_LOGS: 'none' } },
          paths: { tasks: ['keep'], filter: ['a'], cacheDir: 'saved-cache', profile: 'saved.json' },
          policy: { tasks: ['build'], cachePolicy: 'bogus' },
          badenv: { tasks: ['build'], env: { VX_RUN_RETRIES: 'x', VX_CACHE_POLICY: 'local:q' } },
          own: { tasks: ['keep'], filter: ['a'], noCache: true, env: { VX_CACHE_POLICY: 'local:rw' } },
          base: { tasks: ['build'], affected: true },
          solo: { tasks: ['solo'], filter: ['a'] },
          plan: { tasks: ['build'], filter: ['a'], dry: true },
          gone: { tasks: ['build'], filter: ['zzz'] },
          envfail: { tasks: ['need'], filter: ['a'], env: { SHOWN: 'vx-only' } },
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
          need: { exec: { command: 'echo "need SHOWN"; exit 1', env: { passThrough: ['SHOWN'] } } },
          probe: { exec: { command: 'true' }, inputs: { files: ['package.json'], runtime: ['echo "ci=[$CI]" > probe.txt'] }, outputs: { files: [] }, cache: true },
          keep: { exec: { command: 'echo k > k.txt' }, inputs: { files: ['package.json'] }, outputs: { files: ['k.txt'] }, cache: true },
        } }`,
      )
    await addProject(root, 'c', `export default { tasks: { solo: { exec: { command: 'true' } } } }`)
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
    // A runtime probe reads the env its task does: CI is vx's alone.
    expect(await Bun.file(path.join(root, 'packages', 'a', 'probe.txt')).text()).toBe('ci=[]\n')
    // vx itself reads it: the run's output is off.
    const quiet = await vx('pipeline', 'quiet')
    expect([quiet.code, quiet.out.includes('shown=')]).toEqual([0, false])
  }, 30_000)

  // A failure naming a variable only the pipeline set told the user to pass
  // what passThrough already named: no passThrough gives a task vx's own.
  it('says nothing of a variable its env set when a task fails naming it', async () => {
    const r = await vx('pipeline', 'envfail', '--output-logs=full')
    expect([
      r.code,
      r.out.includes('need SHOWN'),
      r.out.includes('set in your environment'),
    ]).toEqual([1, true, false])
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
      const r = await vx('pipeline', 'own', '--dry', '--format', 'json')
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

  // The refusal says `filter(s)`, not `--filter`, so the key went unnamed.
  it('names the key behind a saved filter that matches nothing', async () => {
    const r = await vx('pipeline', 'gone')
    expect([r.code, r.err]).toEqual([
      1,
      expect.stringContaining('no projects matched filter(s): "zzz"'),
    ])
    expect(r.err).toContain('--filter is `pipelines.gone.filter` in .vx/workspace\n')
    // CONTROL: a typed filter is the user's own, no key behind it.
    const typed = await vx('pipeline', 'check', '--filter', 'zzz')
    expect(typed.err).toContain('no projects matched filter(s): "zzz"')
    expect(typed.err).not.toContain('`pipelines.')
  }, 30_000)

  // Every pipeline passes --all, and --all beside a filter is the filter's
  // selection: the hint said "pass --all", which `vx pipeline` refuses and
  // `vx run --all --filter a` had already taken.
  it('widens the filter, not --all, for a task only projects outside it declare', async () => {
    const hint =
      'Only projects outside the selection declare solo — widen --filter to include them, or drop it'
    const saved = await vx('pipeline', 'solo')
    expect([saved.code, saved.err]).toEqual([1, expect.stringContaining(hint)])
    expect(saved.err).toContain('--filter is `pipelines.solo.filter` in .vx/workspace')
    expect(saved.err).not.toContain('pass --all')
    expect((await vx('pipeline', 'check', '--filter', 'b', '--dry')).err).toBe('')
    expect((await vx('run', 'solo', '--all', '--filter', 'a')).err).toContain(hint)
    // CONTROL: a run scoped to the project it stands in is widened by --all.
    cwd = path.join(root, 'packages', 'a')
    try {
      const here = await vx('run', 'solo')
      expect(here.err).toContain('— pass --all, or a --filter that includes them')
    } finally {
      cwd = ''
    }
  }, 30_000)

  // The typed flags were checked alone before the saved ones joined them:
  // `--format json` on a pipeline that saves `dry` was refused as needing --dry.
  it('takes a typed --format for a pipeline that saves dry', async () => {
    const r = await vx('pipeline', 'plan', '--format', 'json')
    expect([r.code, r.err]).toEqual([0, ''])
    expect((JSON.parse(r.out) as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual([
      'a#build',
    ])
    // CONTROL: a pipeline with no saved dry still refuses it.
    const real = await vx('pipeline', 'check', '--format', 'json')
    expect([real.code, real.err]).toEqual([
      1,
      expect.stringContaining('--format prints the plan, so it needs --dry'),
    ])
  }, 30_000)

  it('refuses no name, an unknown one, a task and --all, naming the fix', async () => {
    expect((await vx('pipeline')).err).toContain('missing pipeline name')
    const typo = (await vx('pipeline', 'chek')).err
    expect(typo).toContain(
      'no pipeline named chek; pipelines: check, one, env, quiet, paths, policy',
    )
    expect(typo).toContain('fix  vx pipeline check')
    expect((await vx('pipeline', 'check', 'lint')).err).toContain(
      'vx pipeline runs one pipeline, whose tasks are its `tasks` (got lint)',
    )
    expect((await vx('pipeline', 'check', '--all')).err).toContain(
      '--all: a pipeline runs every project already',
    )
    expect((await vx('pipeline', 'check', '--', 'x')).err).toContain('forwards nothing after --')
    // A name the object's prototype holds is no pipeline: it was taken for
    // one and crashed with a stack.
    for (const name of ['constructor', '__proto__', 'toString']) {
      const r = await vx('pipeline', name)
      expect([r.code, r.err]).toEqual([1, expect.stringContaining(`no pipeline named ${name}`)])
    }
  }, 30_000)
})

// On the base branch a bare --affected has no base. The hint said "drop
// --affected, --all runs every project": `vx pipeline` refuses --all, and a
// saved `affected` is no flag to drop.
describe('vx pipeline with affected, on the base branch', () => {
  let root = ''
  const pipelines = (fields: string): Promise<void> =>
    writeFile(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource([], '', undefined, fields))
  const vx = async (...args: string[]): Promise<{ code: number; err: string }> => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1', VX_AFFECTED_BASE: '' },
    })
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    return { code, err }
  }
  const head = '--affected has no default on the base branch (main): '
  const tail = ', or name the last good commit, --affected=<sha>'

  beforeAll(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-pipeline-base-', git: 'commit' }))
    await addProject(
      root,
      'a',
      `export default { tasks: { build: { exec: { command: 'true' } } } }`,
    )
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'a')
    git(root, 'branch', '-M', 'main')
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('names a pipeline without affected, or the key to drop, never --all', async () => {
    await pipelines(
      `pipelines: { pr: { tasks: ['build'], affected: true }, main: { tasks: ['build'] } }`,
    )
    const saved = await vx('pipeline', 'pr')
    expect(saved.code).toBe(1)
    expect(saved.err).toContain(
      `${head}run vx pipeline main, which has no \`affected\` (the cache skips what did not change)${tail}`,
    )
    expect(saved.err).toContain('--affected is `pipelines.pr.affected` in .vx/workspace\n')
    // Typed, the flag is the user's to drop.
    const typed = await vx('pipeline', 'main', '--affected')
    expect(typed.err).toContain(
      `${head}drop --affected (the cache skips what did not change)${tail}`,
    )
    expect(typed.err).not.toContain('`pipelines.')
    // No pipeline without it: the key is the thing to drop.
    await pipelines(`pipelines: { pr: { tasks: ['build'], affected: true } }`)
    const only = await vx('pipeline', 'pr')
    expect(only.err).toContain(
      `${head}drop \`affected\` from pipelines.pr (the cache skips what did not change)${tail}`,
    )
    for (const r of [saved, typed, only]) expect(r.err).not.toContain('--all')
  }, 60_000)
})
