// Unsafe: a task writing hundreds of MB a second, which strace slows past
// the shard's bound (CLAUDE.md, the output floods).
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { run } from './helpers/orchestrator.js'
import { defaultLogger } from '../src/report/logger.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-flood-' })
  await writeLocalWorkspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const chain = (n: number, first = ''): string =>
  Array.from({ length: n }, (_, i) => {
    const dep = i === 0 ? first : `dependsOn: ['c${i - 1}'], `
    const command = i === n - 1 ? 'exit 1' : 'true'
    return `c${i}: { ${dep}exec: { command: '${command}' } },`
  }).join('\n')

// The readers took every chunk a flood had ready before anything else ran:
// each await of the run waited up to 70 ms behind them, and 30 one-line
// tasks beside `yes` took 11 s instead of 0.2 s. The chain's last task fails
// and fail-fast stops the flood, so the run lasts as long as the chain.
it('a task flooding its output leaves the run its turns', async () => {
  await addProject(
    root,
    'p',
    `export default { tasks: {
      flood: { exec: { command: "yes 'a line of a task that logs without pause'" } },
      ${chain(12)}
    } }`,
  )
  const t = performance.now()
  const r = await run({
    cwd: root,
    tasks: ['flood', 'c11'],
    log: defaultLogger({ enabled: false }, { mode: 'focused' }, { write: () => true }),
    handleSignals: false,
    failFast: true,
  })
  expect(r.outcomes.find((o) => o.node.id === 'p#c11')?.status).toBe('failed')
  expect(performance.now() - t).toBeLessThan(2_000)
}, 60_000)

// A dev server's reader too: a watch cycle's keying and spawns crawled
// while one flooded, and an edit restarted it seconds late or not at all.
// In its own process under `--smol`, where a small probe shows the stall
// (1.8 s against 70 ms): watch missed edits without it too.
it('a server flooding its output leaves the event loop its turns', async () => {
  const runner = path.join(import.meta.dir, '../src/exec/runner.ts')
  const code = `
    import { runPersistent } from ${JSON.stringify(runner)}
    const sp = runPersistent({
      command: "echo start; exec yes 'a line of a server that logs without pause'",
      cwd: process.cwd(), env: { PATH: process.env.PATH }, readyWhen: '^start', onStdout: () => {},
    })
    await sp.ready
    const t = performance.now()
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0))
    console.log(Math.round(performance.now() - t))
    sp.child.kill('SIGKILL')
    await sp.child.exited
    process.exit(0)
  `
  // A file, not `-e`, which hid the stall too.
  const probe = path.join(root, 'probe.ts')
  await Bun.write(probe, code)
  const child = Bun.spawn([process.execPath, '--smol', probe], { cwd: root, stdout: 'pipe' })
  const ms = Number((await new Response(child.stdout).text()).trim())
  expect(await child.exited).toBe(0)
  expect(ms).toBeLessThan(500)
}, 60_000)
