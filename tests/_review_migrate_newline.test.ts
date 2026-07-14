// REPRO: `vx migrate` emits a task's shell command as a single-quoted
// TS string via quote(), which escapes `\` and `'` but NOT raw newlines.
// A package.json script containing a real newline (legal JSON:
// "build": "echo a\necho b") produces a generated vx.config.ts with an
// unterminated string literal → the generated config does NOT round-trip
// through loadProjectConfig (violates the CLAUDE.md invariant that every
// generated config is loadable).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig } from '../src/workspace/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000
let root: string

async function vx(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('REPRO: migrate command with a newline', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-review-mig-'))
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'fixture-root', private: true }),
    )
    await writeFile(path.join(root, 'turbo.json'), JSON.stringify({ tasks: { build: {} } }))
    const dir = path.join(root, 'packages', 'app')
    await mkdir(dir, { recursive: true })
    // A legal JSON script value with a real newline.
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', scripts: { build: 'echo one\necho two' } }),
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'generated vx.config.ts fails to load (unterminated string literal)',
    async () => {
      const res = await vx(['migrate', '--from', 'turbo'])
      expect(res.code).toBe(0) // migrate reports success...

      const generated = path.join(root, 'packages', 'app', 'vx.config.ts')
      const text = await Bun.file(generated).text()
      // The command was spliced raw — the newline is inside the single quotes.
      expect(text).toContain("command: 'echo one\necho two'")

      // ...but the generated config does NOT round-trip: the invariant is
      // "every generated config is loadable". It throws a syntax error.
      let loadErr: unknown = null
      try {
        await loadProjectConfig(generated)
      } catch (e) {
        loadErr = e
      }
      expect(loadErr).not.toBeNull()
      console.log('load error:', loadErr instanceof Error ? loadErr.message : String(loadErr))
    },
    TIMEOUT,
  )
})
