// Forwarded args (after `--`) are for one task in one project (M,
// 2026-11-22): a run of several tasks, or of whatever a change reaches,
// cannot say which command they were meant for.
import { realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseRunArgs } from '../src/cli/run.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const ONE_TASK =
  'forwarded args (after --) go to one task in one project; run that task alone, e.g. vx run app#test -- --watch'

describe('vx run … -- <args>', () => {
  it('refuses them with --affected or several tasks before planning', () => {
    expect(parseRunArgs(['test', '--affected', '--', 'x']).error).toBe(
      `${ONE_TASK} (got --affected)`,
    )
    expect(parseRunArgs(['test', 'lint', '--', 'x']).error).toBe(`${ONE_TASK} (got 2 tasks)`)
    expect(parseRunArgs(['test', 'lint', '--', 'x'], 'watch').error).toBe(
      `${ONE_TASK} (got 2 tasks)`,
    )
  })

  it('takes a task named twice as the one task it is', () => {
    expect(parseRunArgs(['test', 'test', '--', 'x']).error).toBeUndefined()
    expect(parseRunArgs(['test', 'test', 'lint', '--', 'x']).error).toBe(
      `${ONE_TASK} (got 2 tasks)`,
    )
  })

  it('CONTROL: the same runs without forwarded args parse', () => {
    for (const args of [
      ['test', '--affected'],
      ['test', 'lint'],
      ['test', 'lint', '--'],
    ])
      expect(parseRunArgs(args).error).toBeUndefined()
  })

  describe('a --all or --filter run, once planned', () => {
    let root = ''
    const vx = (...args: string[]): { code: number; out: string; err: string } => {
      const r = Bun.spawnSync([process.execPath, BIN, 'run', ...args], {
        cwd: root,
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
      })
      return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
    }
    beforeAll(async () => {
      root = await realpath(await makeWorkspace({ prefix: 'vx-forward-one-' }))
      await addProject(
        root,
        'a',
        `export default { tasks: { say: { exec: { command: 'echo' } } } }`,
      )
      await addProject(
        root,
        'b',
        `export default { tasks: { say: { exec: { command: 'echo' } } } }`,
      )
      await addProject(
        root,
        'c',
        `export default { tasks: { other: { exec: { command: 'true' } } } }`,
      )
    })
    afterAll(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('forwards to the one task it asks for', () => {
      const one = vx('say', '--filter', 'a', '--output-logs=full', '--', 'hi')
      expect([one.code, one.out]).toEqual([0, expect.stringContaining('hi')])
      expect(vx('other', '--all', '--', 'x').code).toBe(0)
    }, 30_000)

    it('refuses a run that asks for the task in several projects, naming them', () => {
      const all = vx('say', '--all', '--', 'hi')
      expect([all.code, all.err]).toEqual([
        1,
        expect.stringContaining(
          'forwarded args (after --) go to one task in one project, and this run asks for 2: a#say, b#say; run that task alone, e.g. vx run a#say -- …',
        ),
      ])
      expect(vx('say', '--filter', 'a', '--filter', 'b', '--', 'hi').code).toBe(1)
      // CONTROL: without args the same run passes.
      expect(vx('say', '--all').code).toBe(0)
    }, 30_000)
  })
})
