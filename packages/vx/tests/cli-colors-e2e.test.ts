// Colour, end to end. `detectColors` is held in colors.test.ts; this holds
// the CLI to it: `vx run` paints only when FORCE_COLOR asks off a TTY (the
// suite's pipes are not one), and NO_COLOR wins; a task runs with colour
// forced and vx strips it where its own output is plain; every other verb prints
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
    "export default { tasks: { build: { exec: { command: 'echo hi' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } }, paint: { exec: { command: `printf 'fc=%s \\\\033[31mred\\\\033[0m\\\\n' \"$FORCE_COLOR\"` }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
  )
  const git = gitIn(root)
  git('init', '-q')
  git('add', '-A')
}, TIMEOUT)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** What `vx <args>` wrote on both streams under `env`. */
function output(args: string[], env: Record<string, string>): string {
  const base = { ...process.env }
  delete base['NO_COLOR']
  delete base['FORCE_COLOR']
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...base, ...env },
  })
  return p.stdout.toString() + p.stderr.toString()
}

/** Whether `vx <args>` wrote an escape sequence on either stream under `env`. */
function painted(args: string[], env: Record<string, string>): boolean {
  return output(args, env).includes(ESC)
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
    "a task's colour: forced on, kept where vx paints, stripped where it does not",
    () => {
      const paint = ['run', 'paint', '--all', '--output-logs', 'full']
      const red = `${ESC}31mred${ESC}0m`
      // The miss under FORCE_COLOR stores the painted bytes; the hit that
      // follows replays them into a pipe, plain.
      const forced = output([...paint, '--force'], { FORCE_COLOR: '1' })
      const replayed = output(paint, {})
      const noColor = output([...paint, '--force'], { NO_COLOR: '1' })
      expect([
        forced.includes(`fc=1 ${red}`),
        replayed.includes('fc=1 red'),
        replayed.includes(ESC),
        noColor.includes('fc= red'),
        noColor.includes(ESC),
      ]).toEqual([true, true, false, true, false])
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
