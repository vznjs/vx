import { bench } from 'mitata'
import { join } from 'node:path'
import { loadConfig } from '../../src/config/load.ts'
import { makeWorkspaceAsync } from '../../tests/_testkit/fixtures.ts'
import { runBench } from '../_harness.ts'

const root = await makeWorkspaceAsync({
  'vx.config.ts': 'export default {}',
})
const path = join(root, 'vx.config.ts')

bench('loadConfig', async () => {
  await loadConfig(path)
})

await runBench()
