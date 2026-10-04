// The npm these suites drive is the root devDependency's, not the host's:
// a machine whose Node came without npm failed 21 rows on `npm` / `npx`
// not found, and a host npm of another major packs and installs by other
// rules than the one pinned here. Its own `bin/npm` wrapper looks for the
// npm bundled beside Node and fails without one, so `npm` and `npx` link
// the CLI scripts directly, alone in a directory: the root's
// `node_modules/.bin` would put `vx` and the linters on PATH too.
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const cli = path.join(path.dirname(Bun.resolveSync('npm/package.json', import.meta.dir)), 'bin')
const NPM_BIN = mkdtempSync(path.join(os.tmpdir(), 'vx-npm-'))
symlinkSync(path.join(cli, 'npm-cli.js'), path.join(NPM_BIN, 'npm'))
symlinkSync(path.join(cli, 'npx-cli.js'), path.join(NPM_BIN, 'npx'))
process.on('exit', () => rmSync(NPM_BIN, { recursive: true, force: true }))

/** `env` with the pinned npm's `npm` and `npx` first on PATH. */
export function withNpm(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: `${NPM_BIN}${path.delimiter}${env['PATH'] ?? ''}` }
}
