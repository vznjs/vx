// A sandboxed task's `./build.sh` that the host has but no grant reads is
// not there inside the sandbox: the shell says "not found", and no trace
// sees an `execve`. The verdict read the host's file and blamed its `#!`
// line (B-66).
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { sandboxReads } from '../src/exec/index.js'
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

  // CONTROL: unsandboxed, the file's own state is still the verdict.
  it('leaves an unsandboxed verdict to the file', () => {
    expect(shellVerdict({ code: 127, command: './build.sh', cwd: dir, bins: [] })).toBe(
      `[vx] exit 127 is the shell's "not found": ./build.sh exists and is executable, and the shell still could not run it — check its #! line (/bin/sh)`,
    )
  })
})
