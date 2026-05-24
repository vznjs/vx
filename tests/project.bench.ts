import { bench } from 'mitata'
import { loadProject } from '../src/project/index.ts'
import { runBench } from './_harness.ts'
import { makeWorkspaceAsync } from './_testkit/fixtures.ts'

const dir = await makeWorkspaceAsync({
  'vx.config.ts': 'export default {}',
})

bench('loadProject', async () => {
  await loadProject(dir)
})

await runBench()
