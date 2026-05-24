import { bench, summary } from 'mitata'
import { runBench } from '../_bench/harness.ts'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'
import { loadConfigs } from './load.ts'

const CONFIG_TS = `
export default {
  tasks: {
    build: { exec: { command: 'echo b' }, dependsOn: ['compile'] },
    compile: { exec: { command: 'echo c' } },
    test: { exec: { command: 'bun test' }, dependsOn: ['build'] },
    lint: { exec: { command: 'oxlint' } },
  },
}
`

async function buildConfigsWorkspace(count: number) {
  const layout: Record<string, string> = {
    'package.json': '{"name":"root","workspaces":["pkg/*"]}',
  }
  const projects = []
  for (let i = 0; i < count; i += 1) {
    layout[`pkg/p${i}/package.json`] = `{"name":"p${i}"}`
    layout[`pkg/p${i}/vx.config.ts`] = CONFIG_TS
    projects.push({ name: `p${i}`, dir: '' })
  }
  const root = await makeWorkspaceAsync(layout)
  return {
    workspace: {
      projects: projects.map((p) => ({ ...p, dir: `${root}/pkg/${p.name}` })),
    },
  }
}

const small = await buildConfigsWorkspace(5)
const medium = await buildConfigsWorkspace(50)
const large = await buildConfigsWorkspace(200)

summary(() => {
  bench('loadConfigs · 5 projects', async () => {
    await loadConfigs(small)
  })
  bench('loadConfigs · 50 projects', async () => {
    await loadConfigs(medium)
  })
  bench('loadConfigs · 200 projects', async () => {
    await loadConfigs(large)
  })
})

await runBench()
