// Colour, end to end. `detectColors` is held in colors.test.ts; this holds
// the CLI to it: `vx run` paints only when FORCE_COLOR asks off a TTY (the
// suite's pipes are not one), and NO_COLOR wins; every other verb prints
// plain text whatever is set, so a script that forces colour for a run's
// log still parses `vx show` or a `--dry` plan.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 60_000
const ESC = '\x1b['

let root = ''
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-colors-', git: false })
  const app = path.join(root, 'packages', 'app')
  await mkdir(path.join(app, 'src'), { recursive: true })
  await writeFile(path.join(app, 'package.json'), '{"name":"app"}')
  await writeFile(path.join(app, 'src', 'a.txt'), 'x\n')
  await writeFile(
    path.join(app, 'vx.config.mjs'),
    "export default { tasks: { build: { exec: { command: 'echo hi' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
  )
  const git = gitIn(root)
  git('init', '-q')
  git('add', '-A')
}, TIMEOUT)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Whether `vx <args>` wrote an escape sequence on either stream under `env`. */
function painted(args: string[], env: Record<string, string>): boolean {
  const base = { ...process.env }
  delete base['NO_COLOR']
  delete base['FORCE_COLOR']
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...base, ...env },
  })
  return (p.stdout.toString() + p.stderr.toString()).includes(ESC)
}

describe('vx paints only a run, and only as the env asks', () => {
  it(
    'vx run: plain off a TTY, painted under FORCE_COLOR=1, plain again under NO_COLOR',
    () => {
      const run = ['run', 'build', '--all', '--force']
      expect([
        painted(run, {}),
        painted(run, { FORCE_COLOR: '1' }),
        painted(run, { FORCE_COLOR: '0' }),
        painted(run, { FORCE_COLOR: '1', NO_COLOR: '1' }),
      ]).toEqual([false, true, false, false])
    },
    TIMEOUT,
  )

  it(
    'every other verb is plain under FORCE_COLOR=1',
    () => {
      const verbs = [
        ['show'],
        ['show', 'app#build'],
        ['info'],
        ['why', 'app#build'],
        ['last'],
        ['last', '--list'],
        ['run', 'build', '--all', '--dry'],
        ['run', 'build', '--all', '--graph'],
        ['cache', 'prune', '--max-size', '1G', '--dry-run'],
        ['help'],
        ['version'],
      ]
      expect(painted(['run', 'build', '--all'], {})).toBe(false)
      expect(verbs.filter((v) => painted(v, { FORCE_COLOR: '1' })).map((v) => v.join(' '))).toEqual(
        [],
      )
    },
    TIMEOUT,
  )
})
