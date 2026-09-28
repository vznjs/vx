// The CLI's verbs, each verb's flags and the `VX_*` variables vx reads are
// a 1.0 contract surface (docs/design/versioning-1.0.md). Scripts and CI
// configs spell them out, so a dropped flag breaks a user as surely as a
// dropped export. `tests/contract/cli-surface.json` records them, so a
// change is a reviewed diff and a removal is a break the break law sees.
// The flags are `verbFlags`, which completions.test.ts holds to each verb's
// parser in both directions; the variables are the source's own reads.
//
// Regenerate after a deliberate change, then review the diff:
//   VX_UPDATE_CONTRACT=1 bun test tests/contract-cli-surface.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { verbFlags } from '../src/cli/completions.js'
import { CORE_VERBS } from '../src/util/index.js'
import { readInSource } from './helpers/env-reads.js'

const RECORD = path.join(import.meta.dir, 'contract', 'cli-surface.json')

it('the verbs, their flags and the VX_ variables are what tests/contract/cli-surface.json records', () => {
  const verbs: Record<string, string[]> = {}
  for (const v of [...CORE_VERBS].sort()) verbs[v] = verbFlags(v).sort()
  const live = { verbs, env: [...readInSource()].sort() }
  const text = JSON.stringify(live, null, 2) + '\n'
  if (process.env['VX_UPDATE_CONTRACT'] === '1' && process.env['CI'] !== 'true') {
    writeFileSync(RECORD, text)
  }
  expect(text).toBe(readFileSync(RECORD, 'utf8'))
})
