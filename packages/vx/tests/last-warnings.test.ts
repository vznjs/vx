// A run's warnings outlive its terminal: `vx last` shows the ones the
// footer counted (`warn  2 warnings above`), so an agent that reads the
// run afterwards sees what it was warned of, not only what failed. Kept
// like the background steps, as rows of cache.db's `warnings`.
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root: string
const vx = (...args: string[]) => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-last-warnings-' })
  await addProject(
    root,
    'a',
    `export default { tasks: {
  lost: { exec: { command: 'true' }, inputs: { files: ['lib/**'] }, cache: { outputs: { files: [] } } },
  quiet: { exec: { command: 'true' }, inputs: { files: ['package.json'] }, cache: { outputs: { files: [] } } },
} }
`,
  )
}, 60_000)
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const warningsDir = () => path.join(root, '.vx', 'cache', 'warnings')

it('a run with no warning keeps none and writes nothing', () => {
  expect(vx('run', 'a#quiet').code).toBe(0)
  const out = JSON.parse(vx('last', '--format', 'json').out) as Record<string, unknown>
  expect(out['warnings']).toBeUndefined()
  expect(existsSync(warningsDir())).toBe(false)
})

it('vx last shows the warnings a run said, plain, in pretty and json', () => {
  const run = vx('run', 'a#lost')
  expect(run.code).toBe(0)
  expect(run.err).toContain('matched no files')
  const json = JSON.parse(vx('last', '--format', 'json').out) as { warnings: string[] }
  expect(json.warnings).toHaveLength(1)
  expect(json.warnings[0]).toContain('a#lost')
  expect(json.warnings[0]).toContain('matched no files')
  expect(json.warnings[0]).not.toContain('\x1b[')
  const pretty = vx('last').out
  expect(pretty).toContain('\n  warnings\n')
  expect(pretty).toContain(`    ${json.warnings[0]!.split('\n')[0]}`)
  // A table `vx last --sql` reads, and no file beside the index.
  const sql = JSON.parse(
    vx(
      'last',
      '--sql',
      `SELECT w.text FROM warnings w JOIN invocations i USING (run_id) ORDER BY i.started_at DESC LIMIT 1`,
      '--format',
      'json',
    ).out,
  ) as { rows: { text: string }[] }
  expect(sql.rows).toEqual([{ text: json.warnings[0]! }])
  expect(existsSync(warningsDir())).toBe(false)
})

it('a later run without warnings does not inherit them', () => {
  expect(vx('run', 'a#quiet').code).toBe(0)
  const out = JSON.parse(vx('last', '--format', 'json').out) as Record<string, unknown>
  expect(out['warnings']).toBeUndefined()
})
