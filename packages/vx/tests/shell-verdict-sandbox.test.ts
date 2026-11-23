// A sandboxed task's `./build.sh` that the host has but no grant reads is
// not there inside the sandbox: the shell says "not found", and no trace
// sees an `execve`. The verdict read the host's file and blamed its `#!`
// line (B-66).
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { sandboxReads } from '../src/sandbox/paths.js'
import { shellVerdict } from '../src/orchestrator/shell-verdict.js'

let dir: string
beforeAll(async () => {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-verdict-sbx-')))
  await mkdir(path.join(dir, 'src'))
  await writeFile(path.join(dir, 'build.sh'), '#!/bin/sh\necho hi\n')
  await chmod(path.join(dir, 'build.sh'), 0o755)
  await symlink(path.join(dir, 'build.sh'), path.join(dir, 'src', 'link.sh'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

const sandbox = (allowRead: string[], allowWrite: string[] = []) => ({
  baseAllowRead: [path.join(dir, 'node_modules')],
  baseDenyRead: [dir],
  config: { allowRead, allowWrite },
})

describe('a script the sandbox hides', () => {
  it('is named as hidden, not blamed on its #! line', () => {
    const hidden = (f: string) => !sandboxReads(sandbox([path.join(dir, 'src')]), f)
    expect(shellVerdict({ code: 127, command: './build.sh', cwd: dir, bins: [], hidden })).toBe(
      `[vx] exit 127 is the shell's "not found": ./build.sh exists, but no sandbox grant reads it, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read`,
    )
  })

  it('is read through a grant at or above it, a write grant, or by its real path', () => {
    const f = path.join(dir, 'build.sh')
    expect([
      sandboxReads(sandbox([dir]), f),
      sandboxReads(sandbox([f]), f),
      sandboxReads(sandbox([], [dir]), f),
      sandboxReads(sandbox([path.join(dir, 'src')]), f),
      // A link under a grant whose target is not: the sandbox binds the target's path.
      sandboxReads(sandbox([path.join(dir, 'src')]), path.join(dir, 'src', 'link.sh')),
      sandboxReads(sandbox([`${dir}-other`]), f),
    ]).toEqual([true, true, true, false, false, false])
  })

  // Only the workspace root and the credential stores are denied: a tool
  // outside them (`/opt/tool/bin/x`) runs, and its missing `#!`
  // interpreter is the verdict, not a grant it never needed.
  it('reads a file outside every denial with no grant', () => {
    const f = path.join(`${dir}-other`, 'tool.sh')
    expect([
      sandboxReads(sandbox([]), f),
      sandboxReads({ ...sandbox([]), baseDenyRead: [`${dir}-other`] }, f),
      sandboxReads({ ...sandbox([f]), baseDenyRead: [`${dir}-other`] }, f),
    ]).toEqual([true, false, true])
  })

  // CONTROL: unsandboxed, the file's own state is still the verdict.
  it('leaves an unsandboxed verdict to the file', () => {
    expect(shellVerdict({ code: 127, command: './build.sh', cwd: dir, bins: [] })).toBe(
      `[vx] exit 127 is the shell's "not found": ./build.sh exists and is executable, and the shell still could not run it — check its #! line (/bin/sh)`,
    )
  })
})

// A hermetic task sees nothing outside its grants: `mkdir` on the host's
// PATH is not there inside, and "install it in this package" sent the
// reader after a tool every host has.
describe('a program a hermetic sandbox hides', () => {
  const hermetic = () => ({
    ...sandbox([dir]),
    config: { allowRead: [dir], allowWrite: [], hermetic: true },
  })
  const hidden = (f: string) => !sandboxReads(hermetic(), f)

  it('is named by its host path, with the grant that reads it', () => {
    const mkdirPath = Bun.which('mkdir')!
    expect(shellVerdict({ code: 127, command: 'mkdir -p dist', cwd: dir, bins: [], hidden })).toBe(
      `[vx] exit 127 is the shell's "command not found": mkdir is ${mkdirPath} on the host, but no sandbox grant reads it, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read`,
    )
  })

  // A redirect or `&&` leaves the command no one word: the shell's own
  // line names it, and the verdict said "install it in this package".
  it("is named from the shell's line when the command is compound", () => {
    const mkdirPath = Bun.which('mkdir')!
    const said = (stderr: string) =>
      shellVerdict({
        code: 127,
        command: 'mkdir -p dist && cp a dist',
        cwd: dir,
        bins: [],
        hidden,
        stderr,
      })
    const want = `[vx] exit 127 is the shell's "command not found": mkdir is ${mkdirPath} on the host, but no sandbox grant reads it, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read`
    expect([
      said('sh: 1: mkdir: not found\n'),
      said('bash: line 1: mkdir: command not found\n'),
    ]).toEqual([want, want])
  })

  it('reads only what a grant holds, outside every denial too', () => {
    expect([
      sandboxReads(hermetic(), path.join(dir, 'build.sh')),
      sandboxReads(hermetic(), path.join(`${dir}-other`, 'tool.sh')),
    ]).toEqual([true, false])
  })
})

// A hermetic `vite build`: vite is in node_modules/.bin, its `#!/usr/bin/env
// node` finds no node, and the shell exits 127. The verdict said "vite is
// not on this task's PATH — install it", and nothing named the runtime.
describe('a found program whose runtime the sandbox hides', () => {
  let bin: string
  let rt: string
  beforeAll(async () => {
    bin = path.join(dir, 'node_modules', '.bin')
    rt = path.join(dir, 'opt-rt')
    await mkdir(bin, { recursive: true })
    await mkdir(rt, { recursive: true })
    await writeFile(path.join(bin, 'tool-a41'), '#!/usr/bin/env rt-a41\n')
    await chmod(path.join(bin, 'tool-a41'), 0o755)
    await writeFile(path.join(rt, 'rt-a41'), '#!/bin/sh\n')
    await chmod(path.join(rt, 'rt-a41'), 0o755)
  })
  const hidden = (f: string) => f.startsWith(`${rt}/`)

  it('names its #! runtime and where the host has it', () => {
    const saved = process.env['PATH']
    process.env['PATH'] = `${rt}${path.delimiter}${saved ?? ''}`
    try {
      expect(
        shellVerdict({ code: 127, command: 'tool-a41 build', cwd: dir, bins: [bin], hidden }),
      ).toBe(
        `[vx] exit 127 is the shell's "not found": tool-a41 is there, but its runtime rt-a41 is ${rt}/rt-a41 on the host, read by no sandbox grant, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read`,
      )
    } finally {
      process.env['PATH'] = saved
    }
  })

  it('names a library its runtime links that the loader could not open', () => {
    expect(
      shellVerdict({
        code: 127,
        command: 'tool-a41 build',
        cwd: dir,
        bins: [bin],
        hidden: (f) => !f.startsWith(`${bin}/`),
        stderr:
          'node: error while loading shared libraries: libnope-a41.so.2: cannot open shared object file: No such file or directory\n',
      }),
    ).toBe(
      `[vx] exit 127 is the shell's "not found": tool-a41 is there, but the loader could not open libnope-a41.so.2, a library its runtime links, which no sandbox grant reads, so inside the sandbox it is not there — add it (or its directory) to exec.sandbox.allow.read`,
    )
  })

  it("names the runtime env's own line says it could not find", () => {
    const saved = process.env['PATH']
    process.env['PATH'] = `${rt}${path.delimiter}${saved ?? ''}`
    try {
      expect(
        shellVerdict({
          code: 127,
          command: 'tool-a41 build',
          cwd: dir,
          bins: [bin],
          hidden: () => false,
          stderr: "/usr/bin/env: 'rt-a41': No such file or directory\n",
        }),
      ).toContain(`tool-a41 is there, but its runtime rt-a41 is ${rt}/rt-a41 on the host`)
    } finally {
      process.env['PATH'] = saved
    }
  })

  it('still says "not on PATH" when the runtime is visible and there', () => {
    const saved = process.env['PATH']
    process.env['PATH'] = `${rt}${path.delimiter}${saved ?? ''}`
    try {
      expect(
        shellVerdict({
          code: 127,
          command: 'tool-a41 build',
          cwd: dir,
          bins: [bin],
          hidden: () => false,
        }),
      ).toContain('tool-a41 is not on this task')
    } finally {
      process.env['PATH'] = saved
    }
  })
})

// No sandbox: `vite` is installed, node is not. The shell's 127 is env's, and
// the verdict said "vite is not on this task's PATH — install it".
describe('a found program whose #! interpreter is missing', () => {
  let bin: string
  beforeAll(async () => {
    bin = path.join(dir, 'nm-bin')
    await mkdir(bin, { recursive: true })
    await writeFile(path.join(bin, 'viaenv-a41'), '#!/usr/bin/env no-runtime-a41\n')
    await writeFile(path.join(bin, 'abs-a41'), '#!/opt/no-such-a41/bin/node\n')
    await chmod(path.join(bin, 'viaenv-a41'), 0o755)
    await chmod(path.join(bin, 'abs-a41'), 0o755)
  })

  it('names the runtime its #!/usr/bin/env line asks for', () => {
    expect(
      shellVerdict({
        code: 127,
        command: 'viaenv-a41 build',
        cwd: dir,
        bins: [bin],
        stderr: "/usr/bin/env: 'no-runtime-a41': No such file or directory\n",
      }),
    ).toBe(
      `[vx] exit 127 is the shell's "not found": viaenv-a41 is ${bin}/viaenv-a41, but its #! line runs no-runtime-a41, which is not on this task's PATH — install it, or put it on PATH`,
    )
  })

  it('names an absolute interpreter that does not exist', () => {
    expect(shellVerdict({ code: 127, command: 'abs-a41', cwd: dir, bins: [bin] })).toBe(
      `[vx] exit 127 is the shell's "not found": abs-a41 is ${bin}/abs-a41, but its #! interpreter /opt/no-such-a41/bin/node does not exist — install it, or put it on PATH`,
    )
  })
})
