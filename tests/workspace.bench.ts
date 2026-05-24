import { bench } from 'mitata'
import { loadWorkspace } from '../src/workspace/index.ts'
import { runBench } from './_harness.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

const layout: Record<string, string> = {
  'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
  'bun.lock': '{}',
}
for (let i = 0; i < 50; i += 1) {
  layout[`packages/p${i}/package.json`] = `{"name":"p${i}","version":"1.0.0"}`
}
const root = await makeWorkspaceAsync(layout)

bench('loadWorkspace · 50 projects', async () => {
  await loadWorkspace(root)
})

await runBench()
