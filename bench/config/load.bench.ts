import { bench, summary } from 'mitata'
import { loadConfigs } from '../../src/config/load.ts'
import type { ConfigSource } from '../../src/config/types.ts'
import { makeWorkspaceAsync } from '../../tests/_testkit/fixtures.ts'
import { runBench } from '../_harness.ts'

const CONFIG_TS = 'export default {}'

async function buildSources(count: number): Promise<ConfigSource[]> {
  const layout: Record<string, string> = {}
  const sources: ConfigSource[] = []
  for (let i = 0; i < count; i += 1) {
    layout[`pkg/p${i}/vx.config.ts`] = CONFIG_TS
    sources.push({ name: `p${i}`, dir: '' })
  }
  const root = await makeWorkspaceAsync(layout)
  return sources.map((s) => ({ ...s, dir: `${root}/pkg/${s.name}` }))
}

const small = await buildSources(5)
const medium = await buildSources(50)
const large = await buildSources(200)

summary(() => {
  bench('loadConfigs · 5 sources', async () => {
    await loadConfigs(small)
  })
  bench('loadConfigs · 50 sources', async () => {
    await loadConfigs(medium)
  })
  bench('loadConfigs · 200 sources', async () => {
    await loadConfigs(large)
  })
})

await runBench()
