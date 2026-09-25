// Count the syscalls of vx ITSELF in an `strace -f -o <file>` trace of a
// run: the tasks' shells and everything they spawn are told apart by PID
// (a PID that calls `execve` is a child — except the root process, whose
// first line is its own `execve`), so a cold run's table is vx's threads
// and not a thousand `sh -c`. This is how items 627 and 630 found the
// restore's spare round trips and the save's two `mkdir`s: a syscall
// count is deterministic where this container's wall time is not.
//
//   strace -f -o /tmp/vx-cold.txt bun packages/vx/src/bin.ts run build --all
//   bun packages/vx-bench/strace-vx.ts /tmp/vx-cold.txt [/tmp/vx-cold-before.txt]
//
// With a second file the table is a diff, `after − before` per syscall.
import { readFileSync } from 'node:fs'

const SPAWNS = new Set(['vfork', 'clone', 'clone3', 'fork'])

/**
 * vx's own syscalls in a trace's text, by name. A spawn that strace split
 * across threads (`clone3(… <unfinished ...>` then `<... clone3 resumed>
 * … = <pid>`) carries its new pid on the RESUMED line: reading only whole
 * calls left git's worker threads unowned, and 3,371 of their
 * `newfstatat`s counted as vx's (the 476-package profile, item 753).
 */
export function countVx(text: string, file = 'trace'): Map<string, number> {
  const lines = text.split('\n')
  const root = /^(\d+)/.exec(lines[0] ?? '')?.[1]
  if (root === undefined) throw new Error(`${file}: not an strace -f -o trace (no leading pid)`)
  const children = new Set<string>()
  const spawnedBy = new Map<string, string>()
  const call = /^(\d+)\s+(\w+)\(/
  const resumed = /^(\d+)\s+<\.\.\. (\w+) resumed>/
  for (const l of lines) {
    const m = call.exec(l) ?? resumed.exec(l)
    if (m === null) continue
    const [, pid, name] = m
    if (name === 'execve' && pid !== root) children.add(pid!)
    const ret = /\) = (\d+)$/.exec(l)
    if (SPAWNS.has(name!) && ret) spawnedBy.set(ret[1]!, pid!)
  }
  // A child's own children are children: settle the spawn tree.
  let changed = true
  while (changed) {
    changed = false
    for (const [c, p] of spawnedBy) {
      if (children.has(p) && !children.has(c)) {
        children.add(c)
        changed = true
      }
    }
  }
  const counts = new Map<string, number>()
  for (const l of lines) {
    const m = call.exec(l)
    if (m === null || l.includes(' resumed>') || children.has(m[1]!)) continue
    counts.set(m[2]!, (counts.get(m[2]!) ?? 0) + 1)
  }
  return counts
}

if (import.meta.main) report(process.argv.slice(2))

function report([after, before]: string[]): void {
  const read = (f: string) => countVx(readFileSync(f, 'utf8'), f)
  if (after === undefined) {
    console.error('usage: bun strace-vx.ts <strace -f -o file> [before file]')
    process.exit(2)
  }
  const a = read(after)
  const b = before === undefined ? undefined : read(before)
  const total = (m: Map<string, number>) => [...m.values()].reduce((x, y) => x + y, 0)
  const rows = [...new Set([...a.keys(), ...(b?.keys() ?? [])])]
    .map((name) => ({ name, after: a.get(name) ?? 0, before: b?.get(name) ?? 0 }))
    .filter((r) => r.after + r.before > 0)
    .sort((x, y) =>
      b ? Math.abs(y.after - y.before) - Math.abs(x.after - x.before) : y.after - x.after,
    )
  if (b === undefined) {
    console.log(`vx-only syscalls: ${total(a)}`)
    for (const r of rows.slice(0, 30)) console.log(`${String(r.after).padStart(8)}  ${r.name}`)
  } else {
    console.log(
      `vx-only syscalls: ${total(b)} → ${total(a)} (${total(a) - total(b) >= 0 ? '+' : ''}${total(a) - total(b)})`,
    )
    for (const r of rows.slice(0, 30)) {
      const d = r.after - r.before
      if (d === 0) continue
      console.log(
        `${String(r.before).padStart(8)} → ${String(r.after).padStart(8)}  ${d > 0 ? '+' : ''}${d}  ${r.name}`,
      )
    }
  }
}
