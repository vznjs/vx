// The fixtures assume git's default stat trust: under a host config setting
// core.checkStat=minimal or core.trustctime=false, vx drops every index OID
// (A-6) and the trusted-OID rows fail for the host, not the code. The gate's
// test tasks run with GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1
// (vx.config.ts). A bare `bun test` cannot be fixed from here: a spawned
// git reads the process's STARTUP environment, so setting process.env in a
// preload reaches no child (probed on Bun 1.4.2). It refuses instead, naming
// the fix. A sandboxed shard has no git; nothing to check there.

import { gitStatWeakened } from '../../src/cache/git-inputs.js'

let vars: string | undefined
try {
  const r = Bun.spawnSync({ cmd: ['git', 'var', '-l'], cwd: '/', stdout: 'pipe', stderr: 'ignore' })
  if (r.exitCode === 0) vars = r.stdout.toString()
} catch {
  // no git on PATH
}
if (vars !== undefined && gitStatWeakened(vars)) {
  throw new Error(
    "this host's git config sets core.checkStat=minimal or core.trustctime=false, which the " +
      'fixtures cannot override; run with GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1',
  )
}
