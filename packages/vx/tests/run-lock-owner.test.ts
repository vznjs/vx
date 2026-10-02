// The run lock lived in the shared temp dir under a name any local user
// could compute, so another user could plant a held lock naming a live
// pid and stall every run on the workspace (audit 48). Each user's locks
// now sit in a directory of their own, and one that is not theirs (a
// link, another owner) is refused: the run warns and goes on unlocked.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { xxh3hex } from '../src/util/index.js'
import { acquireRunLock } from '../src/orchestrator/run-lock.js'

const dirs: string[] = []
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

it.skipIf(process.getuid === undefined)(
  "a lock another user planted stalls no run; a root that is not this user's is refused",
  async () => {
    const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-lock-owner-')))
    dirs.push(dir)
    const ws = path.join(dir, 'ws')
    await mkdir(ws)
    const name = `vx-run-${xxh3hex(realpathSync(ws))}`
    // A held lock naming pid 1, which is alive, where any user can put it:
    // directly in the shared dir, and behind a per-user root that is a link.
    const plant = async (at: string): Promise<void> => {
      await mkdir(path.join(at, name), { recursive: true })
      await writeFile(path.join(at, name, 'h-1-x-0'), '')
    }
    await plant(dir)
    const elsewhere = path.join(dir, 'elsewhere')
    await plant(elsewhere)
    await symlink(elsewhere, path.join(dir, `vx-runs-${process.getuid!()}`))
    const said: string[] = []
    // The default location, the shared temp dir, is the one under test.
    const tmp = process.env.TMPDIR
    process.env.TMPDIR = dir
    const taking = acquireRunLock(ws, { log: (l) => void said.push(l) })
    if (tmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = tmp
    const got = await Promise.race([
      taking.then(async (release) => {
        await release()
        return 'ran'
      }),
      Bun.sleep(2_000).then(() => 'stalled'),
    ])
    expect({
      got,
      said: said.map((l) => l.replace(dir, '<dir>').replace(/ \(.*\) — /, ' (…) — ')),
    }).toEqual({
      got: 'ran',
      said: [
        '[vx] no run lock for this workspace (…) — another vx run on it at the same time may race this one',
      ],
    })
  },
)
