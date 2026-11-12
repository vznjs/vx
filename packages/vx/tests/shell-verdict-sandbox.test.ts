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
