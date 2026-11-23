// vx's own lines in a task's stream (a 127's verdict, a signal death's, a
// variable held back) printed plain white among the task's output, where
// every other `[vx]` line is tagged and coloured.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const ESC = String.fromCharCode(27)

function vx(cwd: string, args: string[], color: boolean): string {
  const env: Record<string, string | undefined> = {
    ...process.env,
    VX_LOCK_REVIEW_FILES: 'false',
    VX_TOKEN_A41: 'x',
  }
  delete env['CI']
  delete env['GITHUB_ACTIONS']
  delete env['NO_COLOR']
  if (color) env['FORCE_COLOR'] = '1'
  else env['NO_COLOR'] = '1'
  const r = Bun.spawnSync([process.execPath, BIN, ...args], { cwd, env })
  return r.stdout.toString() + r.stderr.toString()
}

const vxLine = (out: string, starts: string): string | undefined =>
  out
    .split('\n')
    .find((l) => l.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '').startsWith(starts))

describe("vx's own lines in a task's stream", () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace({ prefix: 'vx-lines-coloured-' })
    await addProject(
      root,
      'app',
      `export default { tasks: {
        nf: { exec: { command: 'no-such-tool-a41' } },
        sig: { exec: { command: 'kill -9 $$' } },
        env: { exec: { command: 'echo "error: VX_TOKEN_A41 is not set" >&2; exit 1' } },
      } }\n`,
    )
    vx(root, ['lock'], false)
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  for (const [task, starts] of [
    ['nf', '[vx] exit 127'],
    ['sig', '[vx] exit 137'],
    ['env', '[vx] VX_TOKEN_A41 is set'],
  ] as const) {
    it(`${task}: painted on a colour terminal, plain without one`, () => {
      const painted = vxLine(vx(root, ['run', `app#${task}`], true), starts)
      expect(painted).toBeDefined()
      expect(painted!.startsWith(`${ESC}[`)).toBe(true)
      const plain = vxLine(vx(root, ['run', `app#${task}`], false), starts)
      expect(plain).toBeDefined()
      expect(plain).not.toContain(ESC)
    })
  }
})
