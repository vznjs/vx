// What the kernel sees vx do to a project's files across one run, counted
// with strace: the syscalls naming each path, in vx's own process (its git
// children are dropped). `load-reads.test.ts` counts what vx ASKS for; this
// counts what happens, Bun's module loader included — which is where the
// config's second read lived: vx read `vx.config.mjs` to key it, and
// `import()` opened and read it again. The loader's `vx-config-bytes`
// onLoad now hands Bun the bytes vx read (workspace/project-loader.ts).
//
// The rows name what stays and why, so a Bun upgrade that moves a count
// fails here with the reason beside it:
//   - `package.json` twice: discovery reads it, and Bun's resolver reads
//     the importer's nearest manifest (its `type`) whatever vx hands it;
//   - the project directory three times: discovery lists it for the
//     config's name (Linux), and the resolver opens it twice;
//   - `vx.workspace.mjs` three times: a probe, vx's read and Bun's. Serving
//     it measured 0.3 ms slower (the parser's first use), so Bun reads it;
//   - `pnpm-workspace.yaml` twice: a probe and one read for the root, the
//     globs and the fingerprint (it was three of each).
// Linux only (strace). CI's Linux job sets VX_REQUIRE_SANDBOX and installs
// strace for the sandbox; without strace there it fails instead of skipping.

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitInitCommit } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 60_000

function required(): boolean {
  const v = process.env['VX_REQUIRE_SANDBOX']
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false'
}

const linux = process.platform === 'linux'
const strace = linux ? Bun.which('strace') : null
if (linux && strace === null && required()) {
  throw new Error('read-once: strace is not on PATH and VX_REQUIRE_SANDBOX is set')
}

/**
 * Syscalls naming each path, in the traced process tree minus every process
 * that exec'd (git): `-y` prints a dirfd as `7</its/path>`, so a path
 * relative to one resolves without tracking descriptors.
 */
function callsByPath(trace: string, cwd: string): Map<string, string[]> {
  const lines = trace.split('\n')
  const first = /^(\d+)\s/.exec(lines[0] ?? '')?.[1]
  const children = new Set<string>()
  for (const l of lines) {
    const m = /^(\d+)\s+execve\(/.exec(l)
    if (m !== null && m[1] !== first) children.add(m[1]!)
  }
  const out = new Map<string, string[]>()
  for (const l of lines) {
    const m = /^(\d+)\s+(\w+)\((.*)$/.exec(l)
    if (m === null || children.has(m[1]!)) continue
    const [, , call, args] = m
    let p: string
    const at = /^(?:AT_FDCWD|\d+)(?:<([^>]*)>)?,\s*"([^"]*)"/.exec(args!)
    if (at !== null) {
      const rel = at[2]!
      p = rel.startsWith('/') ? rel : path.join(at[1] ?? cwd, rel)
    } else {
      const q = /^"([^"]*)"/.exec(args!)
      if (q === null) continue
      p = q[1]!
    }
    const list = out.get(p) ?? []
    list.push(call!)
    out.set(p, list)
  }
  return out
}

describe.skipIf(strace === null)('one run touches each project file once, Bun included', () => {
  let root: string
  let scratch: string

  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-read-once-')))
    root = path.join(scratch, 'ws')
    const dir = path.join(root, 'packages', 'a')
    await mkdir(path.join(dir, 'src'), { recursive: true })
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
    await writeFile(path.join(root, 'vx.workspace.mjs'), 'export default { plugins: [] }\n')
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(path.join(dir, 'src', 'index.js'), 'export {}\n')
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default {
  tasks: {
    build: {
      exec: { command: 'true' },
      cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
    },
  },
}
`,
    )
    gitInitCommit(root)
  })

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  async function tracedRun(name: string): Promise<(rel: string) => string[]> {
    const out = path.join(scratch, `${name}.trace`)
    const p = Bun.spawnSync({
      cmd: [strace!, '-f', '-qq', '-y', '-e', 'trace=%file,%process', '-o', out].concat([
        process.execPath,
        BIN,
        'run',
        'build',
        '--all',
        '--dry',
      ]),
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(p.stderr.toString()).toBe('')
    expect(p.exitCode).toBe(0)
    const calls = callsByPath(await readFile(out, 'utf8'), root)
    return (rel) => (calls.get(path.join(root, rel)) ?? []).sort()
  }

  it(
    'cold: the config is read once, by vx; warm: not at all',
    async () => {
      const cold = await tracedRun('cold')
      expect(cold('packages/a/vx.config.mjs')).toEqual(['openat'])
      expect(cold('packages/a/package.json')).toEqual(['openat', 'openat'])
      expect(cold('packages/a')).toEqual(['openat', 'openat', 'openat'])
      expect(cold('vx.workspace.mjs')).toEqual(['newfstatat', 'openat', 'openat'])
      expect(cold('pnpm-workspace.yaml')).toEqual(['newfstatat', 'openat'])

      // The evaluation is cached. The first warm run reads the config once
      // more, for the file-hash memo the cold run left unwritten (config-cache.ts,
      // `hashBytes`); after it the config is a stat, neither read nor
      // imported, so the resolver never visits its dir.
      const first = await tracedRun('warm-1')
      expect(first('packages/a/vx.config.mjs')).toEqual(['openat', 'statx'])
      const warm = await tracedRun('warm-2')
      expect(warm('packages/a/vx.config.mjs')).toEqual(['statx'])
      expect(warm('packages/a/package.json')).toEqual(['openat'])
      expect(warm('packages/a')).toEqual(['openat'])
      expect(warm('vx.workspace.mjs')).toEqual(['newfstatat', 'openat', 'openat'])
      expect(warm('pnpm-workspace.yaml')).toEqual(['newfstatat', 'openat'])
    },
    TIMEOUT,
  )
})
