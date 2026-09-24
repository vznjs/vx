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
            fc: { exec: { command: 'echo "FC=[$FORCE_COLOR]"' } },
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

  // nx#35292: `0` and `false` are FORCE_COLOR's "off", and read as "on"
  // they wrote escapes into exactly the log this file guards. The task
  // still sees the value as set: vx decides its own colour, not the task's.
  it('FORCE_COLOR=0 and =false leave the piped run plain, and reach the task as set', () => {
    const seen = ['0', 'false'].map((value) => {
      const r = vx(root, { CI: '1', FORCE_COLOR: value }, [
        'run',
        'fc',
        '--all',
        '--output-logs=full',
      ])
      return {
        value,
        code: r.code,
        escapes: r.text.includes('\x1b'),
        task: /^FC=\[[^\]\n]*\]$/m.exec(r.text)?.[0],
      }
    })
    expect(seen).toEqual([
      { value: '0', code: 0, escapes: false, task: 'FC=[0]' },
      { value: 'false', code: 0, escapes: false, task: 'FC=[false]' },
    ])
  })

  // turborepo#8961: the runner wrote its own progress to stderr, so a CI
  // that treats stderr as a warning flagged every green run.
  it('a green run writes nothing to stderr: a miss and a hit, with CI set and without', () => {
    const base: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'NO_COLOR' && k !== 'FORCE_COLOR') base[k] = v
    }
    const seen = [
      ['', 'miss'],
      ['', 'hit'],
      ['1', 'hit'],
    ].map(([ci, label]) => {
      const p = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', 'build', '--all'],
        cwd: root,
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...base, CI: ci!, GITHUB_ACTIONS: '' },
      })
      return {
        ci,
        label,
        code: p.exitCode,
        stdout: p.stdout.length > 0,
        stderr: p.stderr.toString(),
      }
    })
    expect(seen).toEqual([
      { ci: '', label: 'miss', code: 0, stdout: true, stderr: '' },
      { ci: '', label: 'hit', code: 0, stdout: true, stderr: '' },
      { ci: '1', label: 'hit', code: 0, stdout: true, stderr: '' },
    ])
  })
})
