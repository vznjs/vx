// A plugin verb's `--format json` is held like core's read verbs
// (`cli-json-schemas.test.ts`): `vx history` from
// @vzn/vx-schedule-history prints what `schemas/history.json` in that
// package says — every output conforms and every declared field is
// printed. The plugin's own `tests/history-schema.test.ts` holds each
// object's keys to its source type. Unsafe: it reads another package,
// which a sandboxed shard may not.

import { readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { declaredPaths, validate } from './helpers/json-schema.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const PLUGIN = path.resolve(import.meta.dir, '..', '..', 'vx-schedule-history')
const TIMEOUT = 60_000

let root: string
const outputs: unknown[] = []
const schema = JSON.parse(
  readFileSync(path.join(PLUGIN, 'schemas', 'history.json'), 'utf8'),
) as Record<string, unknown>

function vx(args: string[]): { code: number; out: string; err: string } {
  const p = Bun.spawnSync({ cmd: [process.execPath, BIN, ...args], cwd: root })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-plugin-json-' })
  // A declared reservation names both axes, so a row carries each field.
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    `import { scheduleHistoryPlugin } from ${JSON.stringify(path.join(PLUGIN, 'src', 'index.ts'))}
export default {
  plugins: [scheduleHistoryPlugin({ reservations: { 'app#build': { cpus: 2, memory: 512 } } })],
}
`,
  )
  await addProject(root, 'app', {
    config: `export default { tasks: { build: { exec: { command: 'true' } }, lint: { exec: { command: 'true' } } } }`,
  })
  expect(vx(['run', 'app#build']).code).toBe(0)
  const r = vx(['history', '--format', 'json'])
  if (r.code !== 0) throw new Error(`vx history: ${r.code}\n${r.err}`)
  outputs.push(JSON.parse(r.out))
}, TIMEOUT)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('vx history --format json holds to its checked-in schema', () => {
  it('every output conforms and every declared field is printed', () => {
    const seen = new Set<string>()
    for (const out of outputs) expect(validate(schema, out, seen)).toEqual([])
    expect([...declaredPaths(schema)].filter((p) => !seen.has(p))).toEqual([])
  })
})
