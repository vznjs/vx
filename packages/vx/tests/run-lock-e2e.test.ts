// Two vx processes on one workspace serialize (item 216): the second waits
// for the first, says so after a second, and both finish green with the
// tree intact — the race of item 215 (both cleaning and restoring one
// `dist/`) cannot start.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const SLOW = `
  export default {
    tasks: {
      build: {
        exec: { command: 'sleep 1.5 && mkdir -p dist && echo hi > dist/out.txt' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`
const MANY = `
  export default {
    tasks: {
      build: {
        exec: { command: 'mkdir -p dist && for i in $(seq 1 200); do echo hi > dist/out$i.txt; done' },
        cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
      },
    },
  }
`

async function vx(
  cwd: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1' },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('two runs on one workspace', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-run-lock-e2e-' })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'the second waits for the first and says so; both finish green',
    async () => {
      await addProject(root, 'app', { config: SLOW, files: { 'src/index.js': 'export {}\n' } })
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      const first = vx(root, ['run', 'build', '--all'])
      await new Promise((r) => setTimeout(r, 300))
      const second = vx(root, ['run', 'build', '--all'])
      const [a, b] = await Promise.all([first, second])
      expect(`${a.code}\n${a.err}`).toStartWith('0\n')
      expect(`${b.code}\n${b.err}`).toStartWith('0\n')
      expect(b.out + b.err).toMatch(
        /\[vx\] waiting for another vx run \(pid \d+\) on this workspace to finish…/,
      )
      expect(a.out + a.err).not.toContain('waiting for another vx run')
      // The second run found the first's outputs current: a hit, no rebuild.
      expect(b.out + b.err).toMatch(/cache hit|hit  +local|up-to-date/)
    },
    TIMEOUT,
  )

  it(
    'the race of item 215 cannot start: cold outputs, warm cache, two runs, four rounds',
    async () => {
      await addProject(root, 'app', { config: MANY, files: { 'src/index.js': 'export {}\n' } })
      const git = gitIn(root)
      git('add', '-A')
      git('commit', '-q', '-m', 'init')
      const warm = await vx(root, ['run', 'build', '--all'])
      expect(`${warm.code}\n${warm.err}`).toStartWith('0\n')
      const dist = path.join(root, 'packages', 'app', 'dist')
      for (let round = 0; round < 4; round++) {
        await rm(dist, { recursive: true, force: true })
        const [a, b] = await Promise.all([
          vx(root, ['run', 'build', '--all']),
          vx(root, ['run', 'build', '--all']),
        ])
        expect(`${round}:${a.code}\n${a.err}`).toStartWith(`${round}:0\n`)
        expect(`${round}:${b.code}\n${b.err}`).toStartWith(`${round}:0\n`)
        expect(a.out + a.err + b.out + b.err).not.toContain('internal error')
        expect((await Array.fromAsync(new Bun.Glob('out*.txt').scan({ cwd: dist }))).length).toBe(
          200,
        )
      }
    },
    TIMEOUT,
  )
})
