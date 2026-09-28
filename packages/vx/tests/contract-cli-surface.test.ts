// The CLI's verbs, each verb's flags and the `VX_*` variables vx reads are
// a 1.0 contract surface (docs/design/versioning-1.0.md). Scripts and CI
// configs spell them out, so a dropped flag breaks a user as surely as a
// dropped export. `tests/contract/cli-surface.json` records them, so a
// change is a reviewed diff and a removal is a break the break law sees.
// The flags are `verbFlags`, which completions.test.ts holds to each verb's
// parser in both directions; the variables are the source's own reads.
//
// A flag's values are what its parser accepts, asked of the parser itself:
// a value no parser could take is tried first, and a flag that takes it is
// recorded as `*` (a path, a ref, a filter). Otherwise every word the CLI's
// source spells (quoted literals and object keys, where an enum lives) and
// a fixed set of grammar probes (numbers, durations, sizes, cache modes,
// tags) are tried, and the ones it takes are recorded. The probes are fixed,
// not harvested, so an unrelated literal cannot move the record.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-cli-surface.test.ts

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { verbFlags } from '../src/cli/completions.js'
import { CORE_VERBS } from '../src/util/index.js'
import { PARSE } from './helpers/cli-parsers.js'
import { readInSource } from './helpers/env-reads.js'

const RECORD = path.join(import.meta.dir, 'contract', 'cli-surface.json')
const SRC = path.join(import.meta.dir, '..', 'src')

const SENTINEL = 'zq-no-such-value'
const GRAMMAR = [
  ...['-1', '0', '1', '2', '10', '1.5'],
  ...['30s', '30m', '12h', '1d', '1w'],
  ...['10K', '500M', '1G', '2T'],
  ...['local', 'remote', 'local:r', 'local:w', 'local:rw', 'remote:r', 'remote:w', 'remote:rw'],
  ...['k=v', 'k'],
]

/** Every lower-case word the CLI's source quotes or keys an object with. */
function words(): Set<string> {
  const out = new Set<string>()
  for (const dir of ['cli', 'util'])
    for (const f of readdirSync(path.join(SRC, dir)))
      if (f.endsWith('.ts')) {
        const src = readFileSync(path.join(SRC, dir, f), 'utf8')
        for (const m of src.matchAll(/'([a-z][a-z-]*)'|^\s+([a-z][a-z-]*): /gm))
          out.add((m[1] ?? m[2])!)
      }
  return out
}

/** `verb --flag` → the values its parser takes, `*` for any. Bare flags that take no `=value` are left out. */
function flagValues(): Record<string, string[]> {
  const pool = [...new Set([...words(), ...GRAMMAR])]
  const out: Record<string, string[]> = {}
  for (const verb of Object.keys(PARSE).sort()) {
    const parse = PARSE[verb]!
    for (const flag of verbFlags(verb).sort()) {
      if (flag === '--help') continue
      // A cache prune needs a policy; anything but that is the flag's own verdict.
      const policy = verb === 'cache' && flag !== '--older-than' && flag !== '--max-size'
      const extra = policy ? ['--max-size', '1G'] : []
      const needsValue = parse([flag, ...extra]) !== null
      const form = (v: string) => (needsValue ? [flag, v, ...extra] : [`${flag}=${v}`, ...extra])
      if (parse(form(SENTINEL)) === null) out[`${verb} ${flag}`] = ['*']
      else {
        const taken = pool.filter((v) => parse(form(v)) === null).sort()
        if (taken.length > 0 || needsValue) out[`${verb} ${flag}`] = taken
      }
    }
  }
  return out
}

it('the verbs, their flags, the values each takes and the VX_ variables are what tests/contract/cli-surface.json records', () => {
  const verbs: Record<string, string[]> = {}
  for (const v of [...CORE_VERBS].sort()) verbs[v] = verbFlags(v).sort()
  const live = { verbs, values: flagValues(), env: [...readInSource()].sort() }
  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
})
