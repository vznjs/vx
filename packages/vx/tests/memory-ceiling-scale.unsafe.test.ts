// Peak memory of a vx run over many tasks and a large graph (harness:
// tests/helpers/memory-ceiling.ts). Each ceiling is about three times
// today's reading over the floor, cold and warm.

import { beforeAll, describe, expect, it } from 'bun:test'
import { floor, linux, run, TIMEOUT, workspace } from './helpers/memory-ceiling.js'

const cached = (deps = '') =>
  `{ ${deps}exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: [] }, cache: true }`

let base = 0
beforeAll(async () => {
  if (linux) base = await floor()
}, TIMEOUT)

describe.skipIf(!linux)('vx peak memory at scale', () => {
  it(
    '2,000 tasks',
    async () => {
      // 10 projects of 200 tasks: measured +90 MiB cold, +30 warm at 3,000.
      const names = Array.from({ length: 200 }, (_, i) => `t${i}`)
      const config = `export default { tasks: { ${names.map((n) => `${n}: ${cached()}`).join(', ')}, all: { dependsOn: ${JSON.stringify(names)} } } }\n`
      const root = await workspace(
        Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`p${i}`, config])),
      )
      const cold = await run(root, ['all', '--all'])
      const warm = await run(root, ['all', '--all'])
      expect(warm.out).toContain('local 2000✓')
      expect(cold.peak - base).toBeLessThan(256)
      expect(warm.peak - base).toBeLessThan(256)
    },
    TIMEOUT,
  )

  it(
    '1,000 projects in a deep graph',
    async () => {
      // Each project builds after the one before it and the one at half its
      // index: measured +85 MiB cold, +36 warm at 1,500.
      const n = 1000
      const projects: Record<string, string> = {}
      const edges: Record<string, string[]> = {}
      for (let i = 0; i < n; i++) {
        projects[`p${i}`] =
          `export default { tasks: { out: ${cached("dependsOn: ['^out'], ")} } }\n`
        edges[`p${i}`] = i === 0 ? [] : [...new Set([`p${i - 1}`, `p${Math.floor(i / 2)}`])]
      }
      const root = await workspace(projects, { edges })
      const cold = await run(root, ['out', '--all'])
      const warm = await run(root, ['out', '--all'])
      expect(warm.out).toContain('local 1000✓')
      expect(cold.peak - base).toBeLessThan(256)
      expect(warm.peak - base).toBeLessThan(256)
    },
    TIMEOUT,
  )

  it(
    '5,000 projects of 10 files, nothing changed',
    async () => {
      // A nothing-changed run's memory grows with the projects and the files
      // git lists: measured +134-144 MiB warm (2026-11-23); 10,000 projects of
      // 13 files peaked at 275 MB.
      const n = 5000
      const projects: Record<string, string> = {}
      const edges: Record<string, string[]> = {}
      for (let i = 0; i < n; i++) {
        projects[`p${i}`] =
          `export default { tasks: { out: ${cached("dependsOn: ['^out'], ")} } }\n`
        edges[`p${i}`] = i === 0 ? [] : [...new Set([`p${i - 1}`, `p${Math.floor(i / 2)}`])]
      }
      const root = await workspace(projects, { edges, files: 10 })
      await run(root, ['out', '--all'])
      const warm = await run(root, ['out', '--all'])
      expect(warm.out).toContain('local 5000✓')
      expect(warm.peak - base).toBeLessThan(256)
    },
    TIMEOUT * 3,
  )
})
