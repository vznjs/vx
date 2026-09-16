// A CI log's view of the CLI (item 249): every verb, piped, with CI set,
// carries no escape sequence and no carriage return. The status line and
// the colour decision each have their unit pins; this is the whole
// output as a log file receives it.
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

function vx(
  cwd: string,
  env: Record<string, string>,
  args: string[],
): { code: number; text: string } {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'NO_COLOR' && k !== 'FORCE_COLOR') base[k] = v
  }
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...base, ...env },
  })
  return {
    code: p.exitCode ?? 1,
    text: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  }
}

describe('a CI log receives the CLI plain', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-ci-output-' })
    await addProject(root, 'app', {
      config: `
        export default {
          tasks: {
            build: {
              exec: { command: 'echo building && mkdir -p dist && echo hi > dist/out.txt' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
            },
            fail: { exec: { command: 'echo boom >&2; exit 3' } },
          },
        }
      `,
      files: { 'src/a.txt': 'a1\n' },
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('no escape sequence and no carriage return, on a miss, a hit, a failure, and the readers', () => {
    const verbs: [string[], number][] = [
      [['run', 'build', '--all'], 0],
      [['run', 'build', '--all'], 0],
      [['run', 'fail', '--all'], 1],
      [['info'], 0],
      [['show'], 0],
      [['why', 'app#build'], 0],
      [['last'], 0],
    ]
    for (const [args, code] of verbs) {
      const r = vx(root, { CI: '1' }, args)
      expect(`${args.join(' ')}: ${r.code}`).toBe(`${args.join(' ')}: ${code}`)
      expect(`${args.join(' ')}: ${r.text}`).not.toContain('\x1b')
      expect(`${args.join(' ')}: ${r.text}`).not.toContain('\r')
    }
  })

  // CONTROL: the pin can fail — FORCE_COLOR paints a piped stream.
  it('FORCE_COLOR paints the same piped run', () => {
    const r = vx(root, { CI: '1', FORCE_COLOR: '1' }, ['run', 'build', '--all'])
    expect(r.code).toBe(0)
    expect(r.text).toContain('\x1b[')
  })
})
