// The npm these suites drive is the root devDependency's, not the host's:
// a machine whose Node came without npm failed 21 rows on `npm` / `npx`
// not found, and a host npm of another major packs and installs by other
// rules than the one pinned here. Its own `bin/npm` wrapper looks for the
// npm bundled beside Node and fails without one, so `npm` and `npx` link
// the CLI scripts directly, alone in a directory: the root's
// `node_modules/.bin` would put `vx` and the linters on PATH too.
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.join(path.dirname(Bun.resolveSync('npm/package.json', import.meta.dir)), 'bin')
let bin: string | undefined

function npmBin(): string {
  if (bin !== undefined && existsSync(bin)) return bin
  bin = mkdtempSync(path.join(os.tmpdir(), 'vx-npm-'))
  symlinkSync(path.join(cli, 'npm-cli.js'), path.join(bin, 'npm'))
  symlinkSync(path.join(cli, 'npx-cli.js'), path.join(bin, 'npx'))
  return bin
}

/**
 * Removes the links' directory: a test file's `afterAll`. Bun's test runner
 * fires no `process.on('exit')`, where it was, so each process left one.
 */
export function removeNpm(): void {
  if (bin !== undefined) rmSync(bin, { recursive: true, force: true })
  bin = undefined
}

/** `env` with the pinned npm's `npm` and `npx` first on PATH. */
export function withNpm(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: `${npmBin()}${path.delimiter}${env['PATH'] ?? ''}` }
}
