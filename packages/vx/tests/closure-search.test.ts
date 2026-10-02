// `transitiveDeps` answers its first few questions by a search from the
// seed and the rest from the whole graph's bitsets. Both must give the same
// closure in the same order, over any graph the manifests can draw: dev,
// optional and peer edges, a peer that would close a cycle, and a true cycle.

import { describe, expect, it } from 'bun:test'
import { buildPackageGraph } from '../src/workspace/package-graph.js'
import type { ProjectMeta } from '../src/workspace/index.js'

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function workspace(seed: number, cyclic: boolean): ProjectMeta[] {
  const next = rng(seed)
  const n = 30
  const names = Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, '0')}`)
  return names.map((name, i) => {
    const pick = (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (let j = 0; j < n; j++) {
        // Mostly toward later packages (a DAG); a cyclic workspace also
        // points back.
        const forward = j > i && next() < 0.12
        const back = cyclic && j < i && next() < 0.03
        if (forward || back) out[names[j]!] = 'workspace:*'
      }
      return out
    }
    return {
      name,
      dir: `/ws/${name}`,
      configPath: null,
      packageJson: {
        name,
        version: '1.0.0',
        dependencies: pick(),
        devDependencies: pick(),
        peerDependencies: pick(),
      },
    } as unknown as ProjectMeta
  })
}

describe('transitiveDeps by search and by bitsets', () => {
  for (const cyclic of [false, true]) {
    for (let seed = 1; seed <= 12; seed++) {
      it(`agree on every project (seed ${seed}${cyclic ? ', with cycles' : ''})`, () => {
        const metas = workspace(seed, cyclic)
        const names = metas.map((m) => m.name)
        // A fresh graph per question answers it by search.
        const searched = names.map((n) => buildPackageGraph(metas).transitiveDeps(n))
        // One graph asked past its searches answers from the bitsets.
        const g = buildPackageGraph(metas)
        for (let i = 0; i < 8; i++) g.transitiveDeps(`nobody-${i}`)
        const swept = names.map((n) => g.transitiveDeps(n))
        expect(searched).toEqual(swept)
        // CONTROL: the graphs have closures to compare, not only empty ones.
        expect(swept.some((c) => c.length > 1)).toBe(true)
      })
    }
  }
})
