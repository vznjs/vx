import { bench } from 'mitata'
import { findWorkspaceRoot, loadWorkspace } from '../src/workspace/index.ts'
import { runBench } from './_harness.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

const root = await makeWorkspaceAsync({
  'pnpm-workspace.yaml': 'packages: ["packages/*"]',
  'vx.workspace.ts': 'export default {}',
})

bench('findWorkspaceRoot', async () => {
  await findWorkspaceRoot(root)
})

bench('loadWorkspace', async () => {
  await loadWorkspace(root)
})

await runBench()
