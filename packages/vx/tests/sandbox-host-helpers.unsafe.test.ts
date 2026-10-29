// vx keeps two executables of its own in the OS temp dir that the sandbox
// runtime runs OUTSIDE the sandbox: the no-op in ripgrep's place (spawned
// on every wrap) and the env-cutting socat wrapper (the host bridge).
// Where that temp dir is one every sandboxed task may write — SRT binds
// `/tmp/claude` writable into each, and an agent's shell sets TMPDIR to
// it — a task rewrote the no-op and the next task's wrap ran it
// unsandboxed.
// Unsafe: it brings the sandbox up, which cannot nest in a sandboxed shard.
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const linux = process.platform === 'linux'
const available = linux && (await sandboxAvailable('sandbox host helpers test'))
const dirs: string[] = []

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

describe.skipIf(!available)('vx’s host-side helpers in a temp dir tasks may write', () => {
  it('no task can rewrite one, so none runs outside the sandbox', async () => {
    await mkdir('/tmp/claude', { recursive: true })
    const tmp = realpathSync(await mkdtemp('/tmp/claude/vx-hh-'))
    const root = realpathSync(await makeWorkspace({ prefix: 'vx-hh-ws-' }))
    dirs.push(tmp, root)
    const proof = path.join(root, 'escaped')
    const script = `#!/bin/sh\\necho out > ${proof}\\nexit 1\\n`
    const plant = [
      `for f in ${tmp}/vx-noscan-*/rg ${tmp}/vx-socat-*/socat; do`,
      `chmod u+w "$f" 2>/dev/null; printf '${script}' > "$f" && echo "planted $f";`,
      'done; true',
    ].join(' ')
    await addProject(root, 'app', {
      config: `export default { tasks: {
        plant: { exec: { command: ${JSON.stringify(plant)}, sandbox: { allow: { read: ['.'] } } } },
        next: { dependsOn: ['plant'], exec: { command: 'echo next', sandbox: { allow: { read: ['.'] } } } },
      } }\n`,
    })
    const lock = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: root, stderr: 'pipe' })
    expect(lock.exitCode, lock.stderr.toString()).toBe(0)
    const r = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'app#next', '--output-logs', 'full'],
      cwd: root,
      env: { ...process.env, TMPDIR: tmp },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const text = r.stdout.toString() + r.stderr.toString()
    expect(r.exitCode, text).toBe(0)
    // Where it came from: both tasks ran, and the plant found nothing to write.
    expect(text).toContain('next')
    expect(text).not.toMatch(/planted \//)
    expect(await Bun.file(proof).exists()).toBe(false)
  }, 30_000)
})
