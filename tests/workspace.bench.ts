import { bench } from 'mitata'
import { loadWorkspace } from '../src/workspace/index.ts'
import { runBench } from './_harness.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

const layout: Record<string, string> = {
  'vx.workspace.ts': "export default { packages: ['packages/*'] }",
}
for (let i = 0; i < 50; i += 1) {
  layout[`packages/p${i}/.keep`] = ''
}
const root = await makeWorkspaceAsync(layout)

bench('loadWorkspace · 50 projects', async () => {
  await loadWorkspace(root)
})

await runBench()
