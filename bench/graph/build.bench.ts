import { bench, summary } from 'mitata'
import { runBench } from '../_harness.ts'
import type { LoadedConfig } from '../../src/config/types.ts'
import { buildGraph } from '../../src/graph/build.ts'

function project(name: string, tasks: NonNullable<LoadedConfig['config']['tasks']>): LoadedConfig {
  return { project: { name, dir: `/fake/${name}` }, config: { tasks } }
}

function buildConfigs(projectCount: number, tasksPerProject: number): LoadedConfig[] {
  const configs: LoadedConfig[] = []
  for (let p = 0; p < projectCount; p += 1) {
    const tasks: NonNullable<LoadedConfig['config']['tasks']> = {}
    for (let t = 0; t < tasksPerProject; t += 1) {
      const deps: string[] = []
      if (t > 0) deps.push(`t${t - 1}`)
      if (p > 0 && t === 0) deps.push(`p${p - 1}#t${tasksPerProject - 1}`)
      tasks[`t${t}`] = { exec: { command: `echo p${p}-t${t}` }, dependsOn: deps }
    }
    configs.push(project(`p${p}`, tasks))
  }
  return configs
}

const small = buildConfigs(5, 4)
const medium = buildConfigs(50, 6)
const large = buildConfigs(200, 8)
const deep = buildConfigs(1, 100) // long single-project chain

summary(() => {
  bench('buildGraph · 5 projects · 4 tasks each', () => {
    buildGraph({ configs: small, requested: ['t0'] })
  })
  bench('buildGraph · 50 projects · 6 tasks each', () => {
    buildGraph({ configs: medium, requested: ['t0'] })
  })
  bench('buildGraph · 200 projects · 8 tasks each', () => {
    buildGraph({ configs: large, requested: ['t0'] })
  })
  bench('buildGraph · single chain of 100 tasks', () => {
    buildGraph({ configs: deep, requested: ['t99'] })
  })
})

await runBench()
