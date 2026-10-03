// bwrap's `--tmpfs` is writable, and SRT lays one over each read-denied
// directory (the workspace root, the cwd with no read grant): a sandboxed
// write there succeeded and vanished with the sandbox, so a task that
// wrote `../../out.txt` went green with its output gone, where seatbelt
// refuses the same write (2026-10-02).
import { existsSync, realpathSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readOnlyMasks } from '../src/exec/sandbox-binds.js'
import { run } from '../src/orchestrator/index.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

describe('readOnlyMasks', () => {
  it("remounts each mask read-only before bwrap's --, its quoting kept", () => {
    const line =
      "bwrap --ro-bind / / --tmpfs /w --bind /w/p /w/p --tmpfs '/a b/'\"'\"'q' --dev /dev -- sh -c 'x --tmpfs /no'"
    expect(readOnlyMasks(line)).toBe(
      "bwrap --ro-bind / / --tmpfs /w --bind /w/p /w/p --tmpfs '/a b/'\"'\"'q' --dev /dev " +
        "--remount-ro /w --remount-ro '/a b/'\"'\"'q' -- sh -c 'x --tmpfs /no'",
    )
  })

  it("keeps writable the deepest mask a scratch glob's writes land in", () => {
    const line = 'bwrap --tmpfs /w --tmpfs /w/p --tmpfs /w/q -- sh'
    expect(readOnlyMasks(line, ['/w/p/.*.tmp/**'])).toBe(
      'bwrap --tmpfs /w --tmpfs /w/p --tmpfs /w/q --remount-ro /w --remount-ro /w/q -- sh',
    )
  })

  it('CONTROL: a line with no mask is unchanged', () => {
    const line = "bwrap --ro-bind / / -- sh -c 'x --tmpfs /no'"
    expect(readOnlyMasks(line)).toBe(line)
  })
})

const available = await sandboxAvailable('sandbox read-only masks test')
const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

describe.skipIf(!available || process.platform !== 'linux')(
  'a write into a mask, run for real',
  () => {
    let root: string
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-ro-mask-' }))
    })
    afterEach(() => rm(root, { recursive: true, force: true }))

    const project = (command: string, write: string[] = []) =>
      addProject(root, 'app', {
        config: `export default { tasks: { t: { exec: {
        command: ${JSON.stringify(command)},
        sandbox: { allow: { read: ['.'], write: ${JSON.stringify(write)} } },
      } } } }\n`,
      })

    it('is refused, and the failed task names the path', async () => {
      await project('echo x > ../../out.txt || exit 3')
      const r = await run({ cwd: root, tasks: ['t'], log: quiet })
      expect([r.outcomes[0]?.status, r.outcomes[0]?.exitCode]).toEqual(['failed', 3])
      expect(r.outcomes[0]?.sandboxViolationLines).toEqual([
        `vx: the sandbox refused writes outside the project, which are not reported as ` +
          `violations: ${root}/out.txt. If the task needs one, grant its directory, e.g. ` +
          "`allow: { write: ['../../'] }`.",
      ])
      expect(existsSync(path.join(root, 'out.txt'))).toBe(false)
    })

    it('CONTROL: a granted write beneath a mask lands', async () => {
      const dir = await project('mkdir -p dist && echo ok > dist/a.txt && echo t > "$TMPDIR/t"', [
        'dist/',
      ])
      const r = await run({ cwd: root, tasks: ['t'], log: quiet })
      expect([r.outcomes[0]?.status, r.outcomes[0]?.exitCode]).toEqual(['success', 0])
      expect(await readFile(path.join(dir, 'dist', 'a.txt'), 'utf8')).toBe('ok\n')
    })
  },
)
