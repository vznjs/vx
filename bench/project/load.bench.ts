import { bench } from 'mitata'
import { join } from 'node:path'
import { loadProject } from '../../src/project/load.ts'
import { makeWorkspaceAsync } from '../../tests/_testkit/fixtures.ts'
import { runBench } from '../_harness.ts'

const root = await makeWorkspaceAsync({
  'vx.config.ts': 'export default {}',
})
const path = join(root, 'vx.config.ts')

bench('loadProject', async () => {
  await loadProject(path)
})

await runBench()
