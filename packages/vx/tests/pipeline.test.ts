// `vx pipeline <name>` runs a `vx run` saved in `.vx/workspace` (M,
// 2026-11-22): its tasks in every project, each key its flag, a typed flag
// or the flag's variable over the saved value, and its `env` for vx alone.
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
    expect(refusal({ pr: { tasks: ['a'], continue: 'sometimes' } })).toContain(
      '`pipelines.pr.continue`',
    )
    expect(refusal({ pr: { tasks: ['a'], env: { A: 1 } } })).toContain('`pipelines.pr.env`')
    expect(refusal({ pr: { tasks: ['a'], dry: 'yaml' } })).toContain('`pipelines.pr.dry`')
    expect(refusal({ pr: { tasks: ['a'], dry: true, profile: true } })).toBe(
      'ws.ts: `pipelines.pr` sets dry and profile: a dry run writes no profile; drop one',
    )
    expect(refusal({ 'p r': { tasks: ['a'] } })).toContain('pipeline name "p r"')
    expect(refusal(['pr'])).toContain('`pipelines` must be an object')
  })

  it('is the vx run line it saves; a typed flag or its variable beats a key', () => {
    const p: Pipeline = {
      tasks: ['lint', 'test'],
      filter: ['a', 'b'],
      affected: true,
      excludeDependencies: ['gen'],
      concurrency: '50%',
      continue: 'always',
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
      '--continue=always',
      '--profile=p.json',
    ])
    const typed = pipelineRunArgs(p, ['--continue=never', '--filter', 'c'], {
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
  })
})

describe('vx pipeline <name>', () => {
  let root = ''
  const vx = async (...args: string[]): Promise<{ code: number; out: string; err: string }> => {
    const proc = Bun.spawn([process.execPath, BIN, ...args], {
      cwd: root,
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

  it('refuses no name, an unknown one, a task and --all, naming the fix', async () => {
    expect((await vx('pipeline')).err).toContain('missing pipeline name')
    const typo = (await vx('pipeline', 'chek')).err
    expect(typo).toContain('no pipeline named chek; pipelines: check, one, env, quiet')
    expect(typo).toContain('fix  vx pipeline check')
    expect((await vx('pipeline', 'check', 'lint')).err).toContain(
      'vx pipeline runs one pipeline, whose tasks are its `tasks` (got lint)',
    )
    expect((await vx('pipeline', 'check', '--all')).err).toContain(
      '--all: a pipeline runs every project already',
    )
    expect((await vx('pipeline', 'check', '--', 'x')).err).toContain('forwards nothing after --')
  }, 30_000)
})
