// `headStamp` keeps a tracked-outputs mapping while nothing that moves the
// tracked set has moved: HEAD, its reflog, the index. Under reftable ref
// storage (git 2.45) HEAD always reads `ref: refs/heads/.invalid` and there
// is no reflog file, so a commit that left the index alone moved nothing it
// read; the ref stack's table list stands for both there. CI requires a git
// that can make the repository with VX_REQUIRE_REFTABLE.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import { headStamp } from '../src/tracked-outputs.js'

const version = /(\d+)\.(\d+)/.exec(
  Bun.spawnSync(['git', '--version'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString(),
)
const reftable =
  version !== null &&
  (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 45))

it('the host git can make a reftable repository where VX_REQUIRE_REFTABLE asks', () => {
  if (process.env['VX_REQUIRE_REFTABLE'] === '1') expect(reftable).toBe(true)
})

const roots: string[] = []
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ['git', '-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
    { cwd, stdout: 'pipe', stderr: 'pipe' },
  )
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

describe.skipIf(!reftable)('headStamp', () => {
  for (const format of ['files', 'reftable'] as const) {
    it(`moves when HEAD's branch moves and the index does not (${format})`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `vx-stamp-${format}-`))
      roots.push(root)
      git(root, 'init', '-q', `--ref-format=${format}`, '-b', 'main')
      await writeFile(path.join(root, 'a.txt'), 'a')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'one')
      git(root, 'commit', '-qm', 'two', '--allow-empty')
      const before = await headStamp(root)
      // The branch back one commit: no index write, no worktree change.
      git(root, 'update-ref', '-m', 'back', 'refs/heads/main', 'HEAD~1')
      expect(await headStamp(root)).not.toBe(before)
    })
  }
})
