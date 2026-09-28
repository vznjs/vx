// Bun loads `.env`, `.env.local` and `.env.<NODE_ENV>` from the working
// directory into the process unless told not to, and vx's environment is
// where every passThrough, essential and `VX_*` switch is read: a task saw a
// value no shell had set, decided by the directory vx was started from
// (item 1089). `bin.ts`'s shebang runs Bun with --no-env-file, so vx
// installed as a package — `vx`, `bunx`, `node_modules/.bin/vx` — reads the
// environment it was given. The compiled binary is held to the same by
// `scripts/check-binary.ts`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

const WIN32 = process.platform === 'win32'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

// Windows has no shebang launch: `vx` there is a shim over `bun`.
describe.skipIf(WIN32)('a workspace .env stays out of vx', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-dotenv-'))
    await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }),
    )
    await writeFile(path.join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(
      path.join(root, 'packages', 'a', 'vx.config.mjs'),
      `export default { tasks: { probe: { exec: { command: 'echo "probe=\${VX_DOTENV_PROBE-unset}"', env: { passThrough: ['VX_DOTENV_PROBE'] } } } } }\n`,
    )
    await writeFile(path.join(root, '.env'), 'VX_DOTENV_PROBE=from-dotenv\n')
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const probe = (extra: Record<string, string>): string => {
    const env: Record<string, string> = { NO_COLOR: '1', ...extra }
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== 'VX_DOTENV_PROBE' && v !== undefined && !(k in env)) env[k] = v
    }
    // The file itself, not `bun <file>`: the shebang is the launch under test.
    const r = Bun.spawnSync({
      cmd: [BIN, 'run', 'a#probe'],
      cwd: root,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = r.stdout.toString() + r.stderr.toString()
    expect(`${r.exitCode}\n${out}`).toStartWith('0\n')
    return /^probe=(\S+)$/m.exec(out)?.[1] ?? `no probe line in: ${out}`
  }

  it('the executable leaves it out; a value the shell sets still passes through', () => {
    expect(probe({ VX_DOTENV_PROBE: 'from-shell' })).toBe('from-shell')
    expect(probe({})).toBe('unset')
  })
})
