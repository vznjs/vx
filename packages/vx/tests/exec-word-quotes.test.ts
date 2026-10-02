// The shell removes quotes before it looks a word up, so `"./build.sh" x`
// runs ./build.sh; `execWord` split on blanks and kept them, and the 127
// verdict looked for a file named `"./build.sh"` and said it did not exist
// (2026-10-02).
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execWord } from '../src/exec/runner.js'
import { shellVerdict } from '../src/orchestrator/shell-verdict.js'

describe('execWord reads quotes as the shell does', () => {
  it.each([
    ['a double-quoted path with a blank', '"./my tool.sh" x', './my tool.sh'],
    ['a single-quoted path', "'./build.sh' --x", './build.sh'],
    ['quotes inside a word', 'to"o"l x', 'tool'],
    ['a quoted builtin is still the builtin', '"echo" hi', undefined],
    ['an assignment with a quoted value', 'FOO="a b" tool', undefined],
    ['an unterminated quote', '"tool x', undefined],
    ['an empty quoted word', '"" x', undefined],
    ['control: a plain program', 'tool x', 'tool'],
  ])('%s', (_name, command, word) => {
    expect(execWord(command)).toBe(word)
  })
})

describe.skipIf(process.platform === 'win32')('the verdict on a quoted script', () => {
  let cwd: string
  beforeAll(async () => {
    cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-exec-word-')))
    await writeFile(path.join(cwd, 'my build.sh'), '#!/nonexistent/interp\necho hi\n')
    await chmod(path.join(cwd, 'my build.sh'), 0o755)
  })
  afterAll(() => rm(cwd, { recursive: true, force: true }))

  it('the shell runs the quoted file and says not found (the real exit)', () => {
    const r = Bun.spawnSync(['sh', '-c', 'exec "./my build.sh" x'], { cwd, stderr: 'pipe' })
    expect(r.exitCode).toBe(127)
  })

  it('names the #! interpreter, not a missing file', () => {
    expect(shellVerdict({ code: 127, command: '"./my build.sh" x', cwd, bins: [] })).toBe(
      `[vx] exit 127 is the shell's "not found": ./my build.sh exists, and its #! interpreter /nonexistent/interp does not — install it or fix the line`,
    )
  })
})
