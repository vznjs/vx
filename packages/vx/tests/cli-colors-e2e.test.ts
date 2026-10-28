// Colour, end to end. `detectColors` is held in colors.test.ts; this holds
// the CLI to it: `vx run` paints only when FORCE_COLOR asks off a TTY (the
// suite's pipes are not one), and NO_COLOR wins; a task runs with colour
// forced and vx strips it where its own output is plain. Every verb paints
// as a run does (VZN, 2026-10-26: no line of vx reads plain white): on when
// forced, plain into a pipe. Help alone paints only a terminal, so a script
// that greps `vx help` in CI reads plain text.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
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
    "export default { tasks: { build: { exec: { command: 'echo hi' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } }, paint: { exec: { command: `printf 'fc=%s \\\\033[31mred\\\\033[0m\\\\n' \"$FORCE_COLOR\"` }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } } }\n",
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
    'every verb paints as a run does: on when forced, plain into a pipe',
    () => {
      const verbs = [
        ['why', 'app#build'],
        ['last'],
        ['last', '--list'],
        ['run', 'build', '--all', '--dry'],
        ['version'],
      ]
      expect(painted(['run', 'build', '--all'], {})).toBe(false)
      expect(
        verbs.map((v) => [v.join(' '), painted(v, {}), painted(v, { FORCE_COLOR: '1' })]),
      ).toEqual(verbs.map((v) => [v.join(' '), false, true]))
      expect(painted(['help'], { FORCE_COLOR: '1' })).toBe(false)
      // A verb drawn with the ui components paints as a run does: on when
      // forced, plain into a pipe (log-design).
      const clean = ['cache', 'clean', '--max-size', '1G', '--dry']
      expect([painted(clean, {}), painted(clean, { FORCE_COLOR: '1' })]).toEqual([false, true])
      for (const verb of [['show'], ['show', 'app#build']])
        expect([painted(verb, {}), painted(verb, { FORCE_COLOR: '1' })]).toEqual([false, true])
      expect([painted(['info'], {}), painted(['info'], { FORCE_COLOR: '1' })]).toEqual([
        false,
        true,
      ])
    },
    TIMEOUT,
  )
})
