// A run's end on `local()` as core sees it: `bun local-close-fixture.ts
// <root> <pidfile>` starts one worker, closes the adapter, and exits once
// close returns or core's teardown deadline (3 s) passes, whichever is
// first. The worker `local()` starts is this file again (`dte worker`):
// one that never leaves, as a stopped or wedged worker.

import { writeFileSync } from 'node:fs'
import { local } from '../src/local.js'

if (process.argv[2] === 'dte') {
  writeFileSync(process.env['PIDFILE']!, String(process.pid))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1_000)
} else {
  const [root, pidfile] = process.argv.slice(2) as [string, string]
  const adapter = local()
  const relay = await adapter.relay!()
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root })
  await adapter.spawn({
    run: crypto.randomUUID(),
    relay,
    size: 'small',
    max: 1,
    cpu: 1,
    memory: 1,
    index: 1,
    id: 'small#1',
    workspaceRoot: root,
    commit: head.stdout.toString().trim(),
    env: { PIDFILE: pidfile },
    exited() {},
  })
  while (!(await Bun.file(pidfile).exists())) await Bun.sleep(20)
  await Promise.race([adapter.close!(), Bun.sleep(3_000)])
  process.exit(0)
}
