// Tally every `bun:sqlite` statement a run executes, by SQL text, with
// its wall time — the question a stage row cannot answer ("SQLite's
// `run` is 18 % of the profile: which statements, how many?"). Item 615
// found 3,000 autocommit writes per cold config round this way.
//
//   bun --preload packages/vx-bench/sqlite-tally.ts packages/vx/src/bin.ts run build --all
//
// Each statement object is wrapped ONCE: `db.query()` returns a cached
// statement, and a wrapper that re-wrapped it per call counted 500,501
// executions of one query (the trap CLAUDE.md names).
import { Database } from 'bun:sqlite'
const tally = new Map<string, { n: number; ms: number }>()
const wrapped = new WeakSet<object>()
type Loose = (this: unknown, ...a: unknown[]) => unknown
const origPrepare = Database.prototype.prepare as unknown as Loose
const origQuery = Database.prototype.query as unknown as Loose
const origRun = Database.prototype.run as unknown as Loose
const origExec = Database.prototype.exec as unknown as Loose
function wrap(stmt: unknown, sql: string) {
  const s = stmt as Record<string, unknown>
  if (wrapped.has(s)) return stmt
  wrapped.add(s)
  for (const m of ['run', 'get', 'all', 'values']) {
    const f = s[m]
    if (typeof f !== 'function') continue
    s[m] = function (this: unknown, ...args: unknown[]) {
      const t = performance.now()
      try {
        return (f as Loose).apply(this, args)
      } finally {
        const k = m + ' ' + sql.replace(/\s+/g, ' ').slice(0, 90)
        const e = tally.get(k) ?? { n: 0, ms: 0 }
        e.n++
        e.ms += performance.now() - t
        tally.set(k, e)
      }
    }
  }
  return stmt
}
const proto = Database.prototype as unknown as Record<string, Loose>
proto['prepare'] = function (...args: unknown[]) {
  return wrap(origPrepare.apply(this, args), String(args[0]))
}
proto['query'] = function (...args: unknown[]) {
  return wrap(origQuery.apply(this, args), String(args[0]))
}
proto['run'] = function (...args: unknown[]) {
  const t = performance.now()
  try {
    return origRun.apply(this, args)
  } finally {
    const k = 'db.run ' + String(args[0]).replace(/\s+/g, ' ').slice(0, 90)
    const e = tally.get(k) ?? { n: 0, ms: 0 }
    e.n++
    e.ms += performance.now() - t
    tally.set(k, e)
  }
}
proto['exec'] = function (...args: unknown[]) {
  const t = performance.now()
  try {
    return origExec.apply(this, args)
  } finally {
    const k = 'db.exec ' + String(args[0]).replace(/\s+/g, ' ').slice(0, 90)
    const e = tally.get(k) ?? { n: 0, ms: 0 }
    e.n++
    e.ms += performance.now() - t
    tally.set(k, e)
  }
}
process.on('exit', () => {
  const rows = [...tally.entries()].sort((a, b) => b[1].ms - a[1].ms)
  let total = 0,
    count = 0
  for (const [, e] of rows) {
    total += e.ms
    count += e.n
  }
  process.stderr.write(`[sqlite] ${count} executions, ${total.toFixed(1)} ms\n`)
  for (const [k, e] of rows.slice(0, 25))
    process.stderr.write(`  ${e.ms.toFixed(1).padStart(7)} ms ${String(e.n).padStart(6)}x  ${k}\n`)
})
