// A project config that wrote to fd 1 through node:fs (`writeSync(1, …)`,
// `writeFileSync('/dev/stdout', …)`) or through a child it spawned wrote
// into vx's stdout: `vx lock --check --format json` printed it ahead of the
// JSON. The JS routes were redirected; fd 1 itself was not.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'

const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')
const LOADER = path.resolve(import.meta.dir, '../src/workspace/project-loader.ts')
const PRINTS =
  "import fs, { writeSync, writeFileSync } from 'node:fs'\n" +
  "import { execSync } from 'node:child_process'\n" +
  "writeSync(1, 'writeSync\\n')\n" +
  "writeFileSync('/dev/stdout', 'dev-stdout\\n')\n" +
  "fs.writeFileSync('/dev/fd/1', 'dev-fd\\n')\n" +
  "execSync('echo child', { stdio: 'inherit' })\n" +
  "export default { tasks: { build: { exec: { command: 'true' } } } }\n"
const PRINTED = ['writeSync', 'dev-stdout', 'dev-fd', 'child']

let root: string | undefined
/** A workspace of one project, `a`, whose config is `PRINTS`; its config's path. */
async function workspace(): Promise<string> {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-config-fd-stdout-'))
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  const config = path.join(root, 'a', 'vx.config.mjs')
  await Bun.write(config, PRINTS)
  return config
}
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

// Over pipe(2)s, as a shell's `|` makes them: a spawn's pipe is a socket on
// Linux, which `/dev/stdout` cannot open (ENXIO), and `writeFileSync`
// truncates a file, hiding what was written before it.
async function spawned(cwd: string, cmd: string[]) {
  const [out, err, code] = ['out', 'err', 'code'].map((f) => path.join(root!, f))
  const p = Bun.spawn({
    cmd: [
      'sh',
      '-c',
      '{ { "$@"; echo $? >"$C"; } 2>&1 1>&3 3>&- | cat >"$E"; } 3>&1 | cat >"$O"',
      'sh',
      ...cmd,
    ],
    cwd,
    env: { ...process.env, O: out!, E: err!, C: code! },
  })
  await p.exited
  return {
    code: Number(await Bun.file(code!).text()),
    out: await Bun.file(out!).text(),
    err: await Bun.file(err!).text(),
  }
}
const vx = (cwd: string, ...args: string[]) => spawned(cwd, [process.execPath, BIN, ...args])

it('vx lock --check --format json prints only its JSON when a config writes to fd 1', async () => {
  await workspace()
  const r = root!
  const locked = await vx(r, 'lock')
  expect(locked.code).toBe(0)
  for (const line of PRINTED) expect(locked.out).not.toContain(line)
  const check = await vx(r, 'lock', '--check', '--format', 'json')
  expect(check.code).toBe(0)
  expect(() => JSON.parse(check.out)).not.toThrow()
  for (const line of PRINTED) expect(check.err).toContain(`${line}\n`)
}, 30_000)

it('a repeat load, in the worker, keeps fd 1 too', async () => {
  const config = await workspace()
  const driver = path.join(root!, 'driver.ts')
  await Bun.write(
    driver,
    `import { loadProjectConfigs } from ${JSON.stringify(LOADER)}\n` +
      `await loadProjectConfigs([${JSON.stringify(config)}])\n` +
      `await loadProjectConfigs([${JSON.stringify(config)}])\n` +
      `process.stdout.write('done\\n')\n`,
  )
  const { code, out, err } = await spawned(root!, [process.execPath, driver])
  expect({ code, out }).toEqual({ code: 0, out: 'done\n' })
  for (const line of PRINTED) expect(err.split(`${line}\n`).length - 1).toBe(2)
}, 30_000)
