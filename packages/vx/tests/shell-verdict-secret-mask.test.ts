// The frame line vx adds under a 127 names the command's first word. A
// config that interpolated a secret into that word (`tool-${API_TOKEN}`)
// had the task's own "not found" masked and vx's line beside it whole
// (L-37).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const SECRET = 'supersecretvalue123'
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

describe('the shell verdict line', () => {
  it('masks a secret in the word it names, bare or a path', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'vx-verdict-mask-'))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    const dir = path.join(root, 'packages', 'a')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      `export default { tasks: {
  bare: { exec: { command: \`tool-\${process.env.API_TOKEN} --x\` } },
  file: { exec: { command: \`./bin-\${process.env.API_TOKEN}/run\` } },
} }
`,
    )
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root }).exitCode).toBe(0)
    const run = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'a#bare', 'a#file', '--continue'],
      cwd: root,
      env: { ...process.env, API_TOKEN: SECRET },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = run.stdout.toString() + run.stderr.toString()
    expect(run.exitCode).not.toBe(0)
    const verdicts = [
      ...new Set(
        out
          .split('\n')
          .map((l) => l.replace(/^.*?\[vx\] /, '[vx] '))
          // The shell's verdict on a missing path is 127 (dash, bash 5) or
          // 126 (macOS's bash 3.2 under `exec`); the word is the claim here.
          .filter((l) => /^\[vx\] exit 12[67] /.test(l))
          .map((l) =>
            l.replace(/^\[vx\] exit 12[67] is the shell's "[^"]+": /, '').replace(/ — .*/, ''),
          ),
      ),
    ].sort()
    expect(verdicts).toEqual([
      './bin-***/run does not exist',
      "tool-*** is not on this task's PATH",
    ])
    expect(out.includes(SECRET)).toBe(false)
  })
})
