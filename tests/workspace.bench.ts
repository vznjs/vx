import { bench } from 'mitata'
import { loadWorkspace } from '../src/workspace/index.ts'
import { runBench } from './_harness.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

const root = await makeWorkspaceAsync({
  'vx.workspace.ts': "export default { packages: ['packages/*'] }",
})

bench('loadWorkspace', async () => {
  await loadWorkspace(root)
})

await runBench()
