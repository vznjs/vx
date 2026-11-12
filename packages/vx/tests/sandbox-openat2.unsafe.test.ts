// strace never sees an `openat2`, and SRT's write observer records every
// one, read or write, with no flags: a granted `openat2(O_RDONLY)` read
// failed a clean task as `a write no grant covers`, the fix naming a
// write grant (2026-11-07).
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { envFlag } from './helpers/env.js'
import { run } from './helpers/orchestrator.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const available = await sandboxAvailable('sandbox openat2 test')
const python = Bun.which('python3')
if (available && python === null && envFlag('VX_REQUIRE_SANDBOX')) {
  throw new Error('sandbox openat2 test: python3 is not on PATH')
}
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

// openat2 is 437 on every arch Linux numbers syscalls with the generic table.
const script = `import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
class How(ctypes.Structure): _fields_ = [('flags', ctypes.c_uint64), ('mode', ctypes.c_uint64), ('resolve', ctypes.c_uint64)]
how = How(os.O_RDONLY, 0, 0)
fd = libc.syscall(437, -100, sys.argv[1].encode(), ctypes.byref(how), ctypes.sizeof(how))
if fd < 0: sys.exit(1)
sys.stdout.write(os.read(fd, 64).decode())
`

describe.skipIf(!available || python === null || process.platform !== 'linux')(
  'an openat2 read, run for real',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-openat2-' }))
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    const outcome = async (read: string[]) => {
      const dir = await addProject(root, 'app', {
        config: `export default { tasks: { t: { exec: {
        command: '${python} -I o2.py deep/f.txt > out.txt',
        sandbox: { allow: { read: ${JSON.stringify(read)}, write: ['out.txt'] } },
      } } } }\n`,
      })
      await writeFile(path.join(dir, 'o2.py'), script)
      await mkdir(path.join(dir, 'deep'))
      await writeFile(path.join(dir, 'deep', 'f.txt'), 'hi\n')
      const r = await run({ cwd: root, tasks: ['t'], log: quiet })
      const o = r.outcomes[0]
      return [o?.status, o?.sandbox?.violations ?? 0, o?.sandbox?.fix]
    }

    it('passes where a read grant covers it', async () => {
      expect(await outcome(['o2.py', 'deep/'])).toEqual(['success', 0, undefined])
    })

    it('fails where none does, and the fix names a read grant', async () => {
      expect(await outcome(['o2.py'])).toEqual(['failed', 1, { read: ['deep/f.txt'] }])
    })
  },
)
