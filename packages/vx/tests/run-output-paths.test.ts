// Where `vx run` writes the files a flag names, end to end: every output
// path makes its directory, and one it cannot write is said in one line,
// never a stack (item 993).

import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000
let root: string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-output-paths-' })
  await addProject(root, 'a', {
    config: `export default { tasks: { build: { exec: { command: 'echo a' } } } }`,
  })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(...args: string[]): { code: number; err: string } {
  const r = Bun.spawnSync([process.execPath, BIN, 'run', 'build', '--all', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: r.exitCode, err: r.stderr.toString() }
}

describe('output paths (item 993)', () => {
  it(
    '--report-file makes its directory, as --summarize, --profile and --graph do',
    () => {
      const r = vx('--summarize=ns/s.json', '--profile=np/p.json', '--report-file=nr/r.md')
      expect({
        code: r.code,
        written: ['ns/s.json', 'np/p.json', 'nr/r.md'].map((f) => existsSync(path.join(root, f))),
      }).toEqual({ code: 0, written: [true, true, true] })
      expect(vx('--graph=ng/g.dot').code).toBe(0)
      expect(existsSync(path.join(root, 'ng/g.dot'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'a --graph path it cannot write is one line and exit 1, not a stack',
    async () => {
      await mkdir(path.join(root, 'gdir'))
      const r = vx('--graph=gdir')
      expect(r.code).toBe(1)
      expect(r.err).toMatch(/^vx run: failed to write graph to .*gdir: .*EISDIR/)
      expect(r.err.trim().split('\n')).toHaveLength(1)
    },
    TIMEOUT,
  )
})
