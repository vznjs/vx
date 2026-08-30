// Resolve `exec.resources` declarations into the absolute per-task costs the
// scheduler's 2-D admission gate packs against. Pure; the loader has already
// validated every form (this module trusts internal code), so an unparseable
// value can't reach it from a real config.
//
// The declared units are CPU CORES and MEGABYTES — the same numbers on this
// machine and on a remote worker, which is why they are also what
// `TaskPlacement.resources` hands an executor verbatim. Percent forms were
// removed on 2026-08-30: a percentage names a fraction of THIS run's budget,
// and an executor placing the task on someone else's machine has no way to
// mean anything by it.

import type { ResourceCost, TaskNode } from '../graph/index.js'

const BYTES_PER_MB = 1024 * 1024

/** `cpus` → CPU units. Absent → 0 = reserve nothing. */
export function resolveCpu(v: number | undefined): number {
  return v ?? 0
}

/** `memory` (megabytes) → bytes, which is what the budget axis counts. */
export function resolveMem(v: number | undefined): number {
  return v === undefined ? 0 : v * BYTES_PER_MB
}

/**
 * Resolve the whole graph's declared reservations, OMITTING zero-cost
 * tasks: an empty map means "no reservations declared", the single gate
 * the scheduler (and run.ts's option threading) keys off to keep every
 * current run byte-identical.
 */
export function resolveResourceCosts(
  nodes: ReadonlyMap<string, TaskNode>,
): Map<string, ResourceCost> {
  const out = new Map<string, ResourceCost>()
  for (const node of nodes.values()) {
    const declared = node.config.exec?.resources
    if (declared === undefined) continue
    const cpu = resolveCpu(declared.cpus)
    const mem = resolveMem(declared.memory)
    if (cpu > 0 || mem > 0) out.set(node.id, { cpu, mem })
  }
  return out
}
