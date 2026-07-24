// Resolve `exec.resources` declarations into absolute per-task costs the
// scheduler's 2-D admission gate packs against. Pure and budget-
// parameterized — percent forms resolve here, ONCE per run, so the
// scheduler's inner loop only ever does a Map.get. The loader has already
// validated every form (this module trusts internal code); an
// unparseable value can't reach it from a real config.

import type { ResourceCost, TaskNode } from '../graph/index.js'
import { parseSize } from '../util/index.js'

const PERCENT_RE = /^(\d+(?:\.\d+)?)%$/

/**
 * `cpus` → CPU units. A number is itself (fractional ok); `"<n>%"` is
 * percent of the CPU budget, kept fractional (rounding is display-only).
 * Absent → 0 = reserve nothing.
 */
export function resolveCpu(v: number | string | undefined, cpuBudget: number): number {
  if (v === undefined) return 0
  if (typeof v === 'number') return v
  const m = v.match(PERCENT_RE)
  if (m) return (Number(m[1]) / 100) * cpuBudget
  return 0
}

/**
 * `memory` → bytes. A number is bytes; a size string goes through
 * `parseSize` (`"2GB"`, `"512MB"`); `"<n>%"` is percent of the memory
 * budget. Absent → 0 = reserve nothing.
 */
export function resolveMem(v: number | string | undefined, memBudget: number): number {
  if (v === undefined) return 0
  if (typeof v === 'number') return v
  const m = v.match(PERCENT_RE)
  if (m) return (Number(m[1]) / 100) * memBudget
  return parseSize(v) ?? 0
}

/**
 * Resolve the whole graph's declared reservations, OMITTING zero-cost
 * tasks: an empty map means "no reservations declared", the single gate
 * the scheduler (and run.ts's option threading) keys off to keep every
 * current run byte-identical.
 */
export function resolveResourceCosts(
  nodes: ReadonlyMap<string, TaskNode>,
  cpuBudget: number,
  memBudget: number,
): Map<string, ResourceCost> {
  const out = new Map<string, ResourceCost>()
  for (const node of nodes.values()) {
    const declared = node.config.exec?.resources
    if (declared === undefined) continue
    const cpu = resolveCpu(declared.cpus, cpuBudget)
    const mem = resolveMem(declared.memory, memBudget)
    if (cpu > 0 || mem > 0) out.set(node.id, { cpu, mem })
  }
  return out
}
