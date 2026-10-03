// `--profile` writes a Chrome-trace JSON that tools read (Perfetto, a
// script summing `args.cpuMs`), but contract-cli-wire records only
// `--dry=json`, `--summarize` and `--graph`: renaming `args.exitCode` or
// dropping `tid` passed every contract test. This renders the profile
// from outcomes that set every field it reads, records its shape (each
// key path and the JSON types at it) in `tests/contract/profile-wire.json`,
// and holds the sample docs/cli.md prints to that shape.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-profile-wire.test.ts
import { afterAll, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TaskOutcome } from '../src/graph/index.js'
import { writeRunProfile } from '../src/orchestrator/run-artifacts.js'

const RECORD = path.join(import.meta.dir, 'contract', 'profile-wire.json')
const CLI_DOC = path.resolve(import.meta.dir, '..', 'docs', 'cli.md')

function shapeOf(value: unknown, at = '', out: Record<string, Set<string>> = {}): typeof out {
  const add = (t: string): void => void (out[at] ??= new Set()).add(t)
  if (value === null) add('null')
  else if (Array.isArray(value)) {
    add('array')
    for (const v of value) shapeOf(v, `${at}[]`, out)
  } else if (typeof value === 'object') {
    add('object')
    for (const [k, v] of Object.entries(value)) shapeOf(v, at === '' ? k : `${at}.${k}`, out)
  } else add(typeof value)
  return out
}

const flatten = (s: Record<string, Set<string>>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(s)
      .filter(([k]) => k !== '')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, ts]) => [k, [...ts].sort().join(' | ')]),
  )

let dir: string | undefined
afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

async function profileJson(): Promise<unknown> {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-profile-wire-'))
  const outcome = (id: string, extra: Partial<TaskOutcome>): TaskOutcome => {
    const [projectName, taskName] = id.split('#') as [string, string]
    return {
      node: {
        id,
        projectName,
        projectDir: `/ws/${projectName}`,
        taskName,
        config: { exec: { command: 'true' } },
        deps: [],
        requested: true,
      },
      status: 'success',
      exitCode: 0,
      durationMs: 1,
      wallclockStartNs: 1_000_000n,
      wallclockEndNs: 3_000_000n,
      ...extra,
    }
  }
  // Every field the profile reads, and the unkeyed, unmeasured task
  // beside it (`hash: null`, no `cpuMs`).
  const file = await writeRunProfile({
    target: 'profile.json',
    cwd: dir,
    outcomes: [outcome('a#build', { hash: 'h1', cpuMs: 5, peakRssBytes: 4 }), outcome('b#gen', {})],
  })
  return JSON.parse(readFileSync(file, 'utf8'))
}

it('the --profile trace agrees with tests/contract/profile-wire.json', async () => {
  const live = flatten(shapeOf(await profileJson()))
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, JSON.stringify(live, null, 2) + '\n')
  }
  expect(live).toEqual(JSON.parse(readFileSync(RECORD, 'utf8')))
})

it('docs/cli.md shows only keys the trace has, with the types it has', async () => {
  const doc = readFileSync(CLI_DOC, 'utf8')
  const at = doc.indexOf('### `--profile[=<path>]`')
  expect(at).toBeGreaterThan(-1)
  const sample = JSON.parse(/```json\n([\s\S]*?)```/.exec(doc.slice(at))![1]!)
  const live = flatten(shapeOf(await profileJson()))
  const wrong = Object.entries(flatten(shapeOf(sample))).filter(
    ([k, t]) => live[k] === undefined || !t.split(' | ').every((x) => live[k]!.includes(x)),
  )
  expect(wrong).toEqual([])
})
