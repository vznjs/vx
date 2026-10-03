// Data on stdout, everything else on stderr, per verb. A script pipes a
// verb's stdout into `jq`, a file or `dot`; a notice there corrupts it.
// Each row runs a verb whose stdout is a product (a JSON document, the
// plan, the DOT graph, a completion script) against a cache that provokes
// a notice (its index from an older vx), and requires the product alone
// on stdout and the notice on stderr. The reading verbs refuse such a
// cache: on stderr, stdout empty. `vx run`'s own stdout is the run's frame
// (the tasks' output it carries), so it is not a product here.

import { Database } from 'bun:sqlite'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000
const NOTICE = 'cache index reset'

let root = ''
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-streams-', git: false })
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
  expect(vx('run', 'build', '--all')[0]).toBe(0)
}, TIMEOUT)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Make the index look written by an older vx, so the next opener notices. */
function aged(): void {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.run("UPDATE schema_meta SET value = 'v1' WHERE key = 'version'")
  db.close()
}

function vx(...args: string[]): [number, string, string] {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root })
  return [p.exitCode, p.stdout.toString(), p.stderr.toString()]
}

const json = (out: string): boolean => {
  try {
    JSON.parse(out)
    return true
  } catch {
    return false
  }
}

describe('a verb prints its product alone on stdout, a notice on stderr', () => {
  const PRODUCTS: [string[], (out: string) => boolean][] = [
    [['show', '--format', 'json'], json],
    [['show'], (o) => o.startsWith('app ')],
    [['run', 'build', '--all', '--dry=json'], json],
    [['run', 'build', '--all', '--dry'], (o) => o.includes('app#build') && !o.includes(NOTICE)],
    [['run', 'build', '--all', '--graph'], (o) => o.startsWith('digraph ')],
  ]
  for (const [args, product] of PRODUCTS) {
    it(
      `vx ${args.join(' ')}`,
      () => {
        aged()
        const [code, out, err] = vx(...args)
        expect({ code, product: product(out), leaked: out.includes(NOTICE) }).toEqual({
          code: 0,
          product: true,
          leaked: false,
        })
        expect(err).toContain(NOTICE)
      },
      TIMEOUT,
    )
  }

  it(
    'the products that open no index: cache prune --format json, completions',
    () => {
      aged()
      const prune = vx('cache', 'prune', '--max-size', '1G', '--dry-run', '--format', 'json')
      expect([prune[0], json(prune[1])]).toEqual([0, true])
      const comp = vx('completions', 'bash')
      expect([comp[0], comp[1].includes('complete'), comp[2]]).toEqual([0, true, ''])
    },
    TIMEOUT,
  )

  it(
    'a reading verb refuses an older index on stderr, stdout empty',
    () => {
      for (const args of [
        ['info', '--format', 'json'],
        ['why', 'app#build', '--format', 'json'],
        ['last', '--format', 'json'],
      ]) {
        aged()
        const [code, out, err] = vx(...args)
        expect({ args, code, out, refused: err.includes('from an earlier vx') }).toEqual({
          args,
          code: 1,
          out: '',
          refused: true,
        })
      }
    },
    TIMEOUT,
  )
})
