// The args after `--` reach the requested task's command byte for byte:
// never parsed as vx flags, re-cased, type-cast, split, joined or
// dropped, and never handed to a dependency of the same task name. A
// runner that re-serialised parsed flags lost an empty arg, an inner
// `--`, a repeated flag and leading zeros, and read `--base=` and
// `--target` as its own.
import { realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

// Each arg is one `<…>` group: an empty one, or one holding a space or a
// newline, reads as itself.
const SHOW = "printf '<%s>' NAME"

const ARGS = [
  '--x',
  '1',
  '--x',
  '2',
  '--no-y',
  '--z=false',
  'sp ace',
  '',
  '--a.b=1',
  '--fooBar',
  '--foo-bar',
  '$HOME',
  '--',
  "it's",
  '{"a":1}',
  '0010',
  '1e3',
  '"q"',
  '--target',
  'foo',
  '--configuration=x',
  '--base=foo',
  '--all',
  '-',
  '&&',
  'two\nlines',
]

describe('vx run <task> -- <args>', () => {
  let root = ''
  beforeAll(async () => {
    root = await realpath(await makeWorkspace({ prefix: 'vx-fwd-verbatim-', edges: { a: ['b'] } }))
    for (const name of ['a', 'b']) {
      await addProject(
        root,
        name,
        `export default {
          tasks: {
            show: {
              exec: { command: ${JSON.stringify(SHOW.replace('NAME', name))} },
              ${name === 'a' ? "dependsOn: ['^show']," : ''}
            },
          },
        }
        `,
      )
    }
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reaches the requested command verbatim, its same-named dependency gets none, and an open stdin holds nothing', async () => {
    // stdin stays an open pipe nobody writes or closes: a run that waited
    // on it would never end.
    const proc = Bun.spawn(
      [process.execPath, BIN, 'run', 'a#show', '--output-logs=full', '--', ...ARGS],
      {
        cwd: root,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect([code, err]).toEqual([0, ''])
    expect(out).toContain(`<a>${ARGS.map((a) => `<${a}>`).join('')}`)
    expect(out).toContain('<b>')
    expect(out).not.toContain('<b><')
  }, 30_000)
})
