import { bench, summary } from 'mitata'
import { runBench } from '../_bench/harness.ts'
import { makeWorkspaceAsync } from '../_testkit/fixtures.ts'
import { discover } from './discover.ts'

const single = await makeWorkspaceAsync({
  'package.json': '{"name":"solo"}',
})

const small = await buildWorkspace(5)
const medium = await buildWorkspace(50)
const large = await buildWorkspace(200)

async function buildWorkspace(count: number) {
  const layout: Record<string, string> = {
    'package.json': '{"name":"root","workspaces":["pkg/*"]}',
  }
  for (let i = 0; i < count; i += 1) {
    layout[`pkg/p${i}/package.json`] = `{"name":"p${i}"}`
  }
  return makeWorkspaceAsync(layout)
}

summary(() => {
  bench('discover · single project', async () => {
    await discover({ root: single })
  })
  bench('discover · 5 projects', async () => {
    await discover({ root: small })
  })
  bench('discover · 50 projects', async () => {
    await discover({ root: medium })
  })
  bench('discover · 200 projects', async () => {
    await discover({ root: large })
  })
})

await runBench()
