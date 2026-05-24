import { bench } from 'mitata'
import { loadProject } from '../../src/project/index.ts'
import { makeWorkspaceAsync } from '../../tests/_testkit/fixtures.ts'
import { runBench } from '../_harness.ts'

const dir = await makeWorkspaceAsync({
  'vx.config.ts': 'export default {}',
})

bench('loadProject', async () => {
  await loadProject(dir)
})

await runBench()
