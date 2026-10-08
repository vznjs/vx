// A project config is served to Bun as a module unless it may be CommonJS:
// a name Bun takes as CommonJS (or a backslash, which can spell one) sends
// it to the parser, and one with no ESM `export` takes Bun's own path.
// Source with none of those names skips the parse, so a syntax error now
// reaches the served path, whose position carries the `?vx-held=` query.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { loadProjectConfig } from '../src/workspace/project-loader.js'

let dir: string
beforeEach(async () => {
  // Canonical: Bun names the real path, and macOS's temp root is a link.
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-cjs-hint-')))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const TASKS = `{ build: { exec: { command: 'tsc' } } }`

it('each name that makes Bun run a config as CommonJS keeps it CommonJS', async () => {
  const forms: Record<string, string> = {
    'exports.js': `exports.tasks = ${TASKS}\n`,
    // Escaped, neither word is one the source spells out.
    'escaped.js': `\\u006dodule.\\u0065xports = { tasks: ${TASKS} }\n`,
    'this.mjs': `this.tasks = ${TASKS}\n`,
    'require.ts': `const r = require\nmodule.exports = { tasks: ${TASKS} }\n`,
    // TypeScript's CommonJS export, no CommonJS name spelled: served as a
    // module, its value vanished and the config "did not export a default".
    'assign.cts': `export = { tasks: ${TASKS} }\n`,
    'assignts.ts': `const config = { tasks: ${TASKS} }\nexport = config\n`,
  }
  for (const [name, source] of Object.entries(forms)) {
    const file = path.join(dir, name.replace('.', '/vx.config.'))
    await mkdir(path.dirname(file))
    await writeFile(file, source)
    expect([name, (await loadProjectConfig(file)).tasks?.build?.exec?.command]).toEqual([
      name,
      'tsc',
    ])
  }
})

it('a syntax error in a served config names the file and line, never the query', async () => {
  const real = path.join(dir, 'real')
  await mkdir(real)
  await writeFile(path.join(real, 'vx.config.mjs'), 'const x = {\n')
  await symlink(real, path.join(dir, 'link'))
  const message = (file: string) =>
    loadProjectConfig(file).then(
      () => 'loaded',
      (err: Error) => err.message,
    )
  const direct = path.join(real, 'vx.config.mjs')
  expect(await message(direct)).toBe(
    `Project config ${direct}:1:12: Expected identifier but found end of file`,
  )
  const linked = path.join(dir, 'link', 'vx.config.mjs')
  expect(await message(linked)).toBe(
    `Project config ${linked} (in ${direct}:1:12): Expected identifier but found end of file`,
  )
})

it('CONTROL: an ESM config loads', async () => {
  const file = path.join(dir, 'vx.config.mjs')
  await writeFile(file, `export default { tasks: ${TASKS} }\n`)
  expect((await loadProjectConfig(file)).tasks?.build?.exec?.command).toBe('tsc')
})
