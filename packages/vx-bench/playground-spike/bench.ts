// W9 spike (item 676): how long one plan takes inside the bundle — the
// playground re-plans on every edit, so this is its interaction latency.
//
//   bun packages/vx-bench/playground-spike/bench.ts     (after build.ts)
//
// Two workspaces: the spike fixture, and a synthetic chain of N projects
// with F source files each (every project `build` depends on `^build`).
// Min and median of R plans each, in Bun (JavaScriptCore, like Safari; a
// browser tab's number is of the same order, not identical).

import path from 'node:path'
import { CONFIGS, ENV, FILES } from './fixture.js'

type Plan = (input: {
  root: string
  files: Record<string, string>
  configs: Record<string, unknown>
  env: Record<string, string>
  tasks: string[]
}) => Promise<{ tasks: unknown[] }>

const { planPlayground } = (await import(path.join(import.meta.dir, 'dist/entry.js'))) as {
  planPlayground: Plan
}

function synthetic(n: number, f: number) {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'syn', private: true, workspaces: ['packages/*'] }),
    'bun.lock': '{}\n'.repeat(2000),
  }
  const configs: Record<string, unknown> = {}
  for (let i = 0; i < n; i++) {
    const name = `@syn/p${i}`
    const deps = i === 0 ? {} : { [`@syn/p${i - 1}`]: 'workspace:*' }
    files[`packages/p${i}/package.json`] = JSON.stringify({ name, dependencies: deps })
    files[`packages/p${i}/vx.config.mjs`] = 'export default {}\n'
    for (let k = 0; k < f; k++)
      files[`packages/p${i}/src/f${k}.ts`] = `export const v${k} = ${i * k}\n`.repeat(20)
    configs[name] = {
      tasks: {
        build: {
          dependsOn: ['^build'],
          exec: { command: 'tsc' },
          cache: { inputs: { files: ['src/**/*.ts'] }, outputs: { files: ['dist/**'] } },
        },
      },
    }
  }
  return { files, configs }
}

async function time(label: string, input: Parameters<Plan>[0], reps: number) {
  const ms: number[] = []
  let tasks = 0
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now()
    tasks = (await planPlayground(input)).tasks.length
    ms.push(performance.now() - t0)
  }
  ms.sort((a, b) => a - b)
  return {
    label,
    files: Object.keys(input.files).length,
    tasks,
    minMs: +ms[0]!.toFixed(1),
    medianMs: +ms[Math.floor(reps / 2)]!.toFixed(1),
  }
}

const syn = synthetic(50, 20)
console.log(
  JSON.stringify(
    [
      await time(
        'spike fixture',
        { root: '/ws', files: FILES, configs: CONFIGS, env: ENV, tasks: ['build', 'ci'] },
        15,
      ),
      await time(
        '50 projects x 20 files',
        { root: '/ws', files: syn.files, configs: syn.configs, env: {}, tasks: ['build'] },
        7,
      ),
    ],
    null,
    2,
  ),
)
