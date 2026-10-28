// A `vx dte worker` in a process of its own, for the tests that signal
// it: `bun worker-child.ts <relay> <run> <root>`. Its cache holds nothing.

import type { TaskArtifacts } from '@vzn/vx'
import { secretProof } from '../src/seal.js'
import { runWorker } from '../src/worker.js'

const [relay, run, root] = process.argv.slice(2) as [string, string, string]
const artifacts: TaskArtifacts = {
  async save() {},
  async output() {
    return null
  },
  async share() {
    return false
  },
  async resend() {
    return false
  },
  async restore() {
    return null
  },
}
// As the CLI ends once its verb has: a timer a dependency left holds no exit.
const code = await runWorker({
  relay,
  run,
  root,
  token: async () => undefined,
  proof: secretProof('s'),
  artifacts: () => artifacts,
})
process.exit(code)
