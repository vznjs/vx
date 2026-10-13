// vx strips undeclared variables from a task's env, but vx's own process
// still holds them (a token, a cache signing key). Can a task read them
// back from vx? Linux: `/proc/<pid>/environ` of any same-user process.
// macOS: `ps eww`, which reads another process's env through sysctl
// KERN_PROCARGS2. A sandboxed task must find nothing; an unsandboxed one
// does, and that control proves the probe works.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const available = await sandboxAvailable('sandbox parent env test')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

// The canary is read from a file: as a grep argument it would sit in the
// probe's own command line, which `ps eww` prints.
const PROBE = [
  'env | grep -qF -f canary.pat && echo OWN-ENV',
  'hit=; for f in /proc/[0-9]*/environ; do grep -qaF -f canary.pat "$f" 2>/dev/null && hit=1; done; [ -n "$hit" ] && echo LEAK-proc',
  '[ "$(uname)" = Darwin ] && ps eww -ax 2>/dev/null | grep -qF -f canary.pat && echo LEAK-ps',
  'echo DONE',
].join('\n')

describe.skipIf(!available)("a task and vx's own environment", () => {
  it('a sandboxed task cannot read it; an unsandboxed one can', async () => {
    root = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-penv-')))
    const ws = path.join(root, 'ws')
    const canary = `vxcanary${crypto.randomUUID().replaceAll('-', '')}`
    await mkdir(path.join(ws, 'packages', 'a'), { recursive: true })
    await writeFile(
      path.join(ws, 'package.json'),
      JSON.stringify({ name: 'r', private: true, workspaces: ['packages/*'] }),
    )
    await writeFile(path.join(ws, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a' }))
    await writeFile(path.join(ws, 'packages', 'a', 'canary.pat'), `${canary}\n`)
    await writeFile(
      path.join(ws, 'packages', 'a', 'vx.config.mjs'),
      `export default { tasks: {
  boxed: { exec: { command: ${JSON.stringify(PROBE)}, sandbox: { allow: { read: ['.'] } } } },
  open: { exec: { command: ${JSON.stringify(PROBE)} } },
} }
`,
    )
    expect(Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: ws }).exitCode).toBe(0)
    const out = (task: string): string[] => {
      const r = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', `a#${task}`, '--output-logs', 'full'],
        cwd: ws,
        env: { ...process.env, VX_PROBE_CANARY: canary },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const text = r.stdout.toString() + r.stderr.toString()
      expect(r.exitCode, text).toBe(0)
      return text
        .split('\n')
        .map((l) => l.replace(/^.*?│\s?/, '').trim())
        .filter((l) => /^(OWN-ENV|LEAK-proc|LEAK-ps|DONE)$/.test(l))
    }
    expect({ boxed: out('boxed'), open: out('open') }).toEqual({
      boxed: ['DONE'],
      open: [process.platform === 'linux' ? 'LEAK-proc' : 'LEAK-ps', 'DONE'],
    })
  })
})
