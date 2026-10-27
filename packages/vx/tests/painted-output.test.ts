// No line vx prints for a person reads plain white (VZN, 2026-10-26): with
// colors on, every non-blank line of every verb carries a color or a weight.
// `vx run --dry`, `vx last` and `vx why` printed whole blocks of bare text,
// and a notice's body was bare under its painted headline. A task's own
// output, between its frame's `┌` and `└`, is the task's bytes, not vx's;
// a `::error` line is a CI's workflow command, which its log never shows.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-painted-' })
  const a = path.join(root, 'packages', 'a')
  await mkdir(path.join(a, 'src'), { recursive: true })
  await writeFile(path.join(a, 'package.json'), '{"name":"a"}')
  await writeFile(path.join(a, 'src', 'x.txt'), 'x\n')
  await writeFile(
    path.join(a, 'vx.config.mjs'),
    `export default { tasks: {
  build: { exec: { command: 'echo built > out.txt' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } } },
  bad: { exec: { command: 'echo boom >&2; exit 2' } },
} }
`,
  )
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const vx = (...args: string[]): string => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '' },
  })
  return p.stdout.toString() + p.stderr.toString()
}

it('every line of every verb is painted', () => {
  // Order matters: `last` and `why` read the runs before them.
  const verbs = [
    ['--version'],
    ['run', 'a#build'],
    ['run', 'a#build'],
    ['run', 'a#bad'],
    ['run', 'a#build', '--dry'],
    ['show', 'a#build'],
    ['info'],
    ['last'],
    ['last', '--list'],
    ['why', 'a#build'],
    ['cache'],
    ['nosuchverb'],
    ['run', 'nosuchtask'],
  ]
  const plain = verbs.flatMap((args) => {
    let framed = false
    return vx(...args)
      .split('\n')
      .filter((l) => {
        if (l.includes('┌')) framed = true
        if (l.includes('└')) framed = false
        return !framed && l.trim() !== '' && !l.startsWith('::') && !l.includes('\x1b[')
      })
      .map((l) => `vx ${args.join(' ')}: ${l}`)
  })
  expect(plain).toEqual([])
}, 60_000)
