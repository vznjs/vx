// macOS samples a running task's tree with `ps` every 250 ms while tasks
// run, and `ps eww` shows a same-user task any process's env. That `ps`
// ran with vx's whole startup env, so a token vx never passed a task was
// readable there. It now gets PATH alone (`helperEnv`).
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'

const SAMPLE = path.resolve(import.meta.dir, '..', 'src', 'exec', 'proc-sample.ts')
let root: string | undefined

afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

it("the ps that samples a task's tree sees PATH alone, not vx's env", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-ps-env-'))
  const seen = path.join(root, 'seen')
  await writeFile(
    path.join(root, 'ps'),
    `#!/bin/sh\nenv | sed 's/=.*//' | sort > ${JSON.stringify(seen)}\necho "$$ 1 10 0:00.01"\n`,
  )
  await chmod(path.join(root, 'ps'), 0o755)
  const script = `
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const { sampleTrees } = await import(${JSON.stringify(SAMPLE)})
    await sampleTrees([process.pid])
  `
  const r = Bun.spawnSync({
    cmd: [process.execPath, '-e', script],
    env: {
      PATH: `${root}${path.delimiter}${process.env['PATH']}`,
      HOME: os.homedir(),
      VX_TEST_TOKEN: 'canary-secret-value',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)
  const names = (await readFile(seen, 'utf8')).trim().split('\n')
  // The shell sets PWD, SHLVL and `_` itself; vx passed PATH alone.
  expect(names.filter((n) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n))).toEqual(['PATH'])
})
