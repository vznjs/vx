// `vx run --format json`: the `--summarize` document alone on stdout, the
// frame and the tasks' output on stderr, the exit code unchanged.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'
import type { RunSummaryJson } from '../src/orchestrator/run-artifacts.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

let root = ''
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-runjson-', git: false })
  const app = path.join(root, 'packages', 'app')
  await mkdir(path.join(app, 'src'), { recursive: true })
  await writeFile(path.join(app, 'package.json'), '{"name":"app"}')
  await writeFile(path.join(app, 'src', 'a.txt'), 'x\n')
  await writeFile(
    path.join(app, 'vx.config.mjs'),
    `export default {
  tasks: {
    build: { exec: { command: 'echo built-marker' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } },
    bad: { exec: { command: 'echo bad-marker; exit 3' } },
  },
}
`,
  )
  const git = gitIn(root)
  git('init', '-q')
  git('add', '-A')
}, TIMEOUT)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(...args: string[]): [number, string, string] {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root })
  return [p.exitCode, p.stdout.toString(), p.stderr.toString()]
}

describe('vx run --format json', () => {
  it(
    'prints the result document alone on stdout, the run on stderr',
    () => {
      for (const status of ['success', 'cache-hit']) {
        const [code, out, err] = vx('run', 'app#build', '--format', 'json')
        expect(code).toBe(0)
        const doc = JSON.parse(out) as RunSummaryJson
        expect(doc.ok).toBe(true)
        expect(doc.exitCode).toBe(0)
        expect(doc.tasks.map((t) => [t.id, t.status])).toEqual([['app#build', status]])
        expect(err).toContain('built-marker')
      }
    },
    TIMEOUT,
  )

  it(
    'a failed run keeps exit 1 and says so in the document',
    () => {
      const [code, out, err] = vx('run', 'app#bad', '--format=json')
      expect(code).toBe(1)
      const doc = JSON.parse(out) as RunSummaryJson
      expect([doc.ok, doc.exitCode]).toEqual([false, 1])
      expect(doc.tasks.map((t) => [t.id, t.status, t.exitCode])).toEqual([['app#bad', 'failed', 3]])
      expect(err).toContain('bad-marker')
    },
    TIMEOUT,
  )

  it(
    'refuses flags that also print on stdout, and a bad value',
    () => {
      const cases: [string[], string][] = [
        [['--dry'], '--format json runs the tasks; --dry=json prints the plan'],
        [['--graph'], '--format json and --graph both print on stdout; give --graph a file'],
        [
          ['--report'],
          '--format json and --report=markdown both print on stdout; use --report-file',
        ],
      ]
      for (const [extra, message] of cases) {
        const [code, out, err] = vx('run', 'build', '--all', '--format', 'json', ...extra)
        expect([code, JSON.parse(out)]).toEqual([
          1,
          {
            ok: false,
            error: {
              code: 'VX_E_USAGE',
              message: expect.stringContaining(message),
              docs: 'https://vznjs.github.io/vx/cli/#vx_e_usage',
            },
          },
        ])
        expect(err).toContain(message)
      }
      const [code, , err] = vx('run', 'build', '--all', '--format', 'yaml')
      expect(code).toBe(1)
      expect(err).toContain('--format must be pretty or json (got yaml)')
    },
    TIMEOUT,
  )
})
