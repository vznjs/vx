// Run outcomes over seeded random graphs whose tasks pass, fail, flake
// (`exec.retries`), time out (`exec.timeout`, with and without retries)
// and cache, under each `continueMode`. Every attempt appends a line to a
// marker file outside every key, so "started" and "attempts" are read from
// disk. A second run with the same keys proves what was saved. It found
// a retry's clean pruning a directory a sibling had just made (retries.test.ts).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import type { ContinueMode } from '../src/graph/index.js'
import { gitInitCommit } from './helpers/workspace.js'
import { rng } from './helpers/rng.js'

const errs: string[] = []
const log: Logger = {
  status: () => undefined,
  taskStdout: () => undefined,
  taskStderr: (n, t) => void errs.push(`${n.id}: ${t}`),
  taskComplete: () => undefined,
}

let tmp = ''
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-rtprop-'))
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

type Kind = 'pass' | 'fail' | 'flake' | 'timeout'
interface Spec {
  kind: Kind
  fails: number
  retries: number
  passes: boolean
}

async function scenario(mode: ContinueMode, seed: number, iter: number): Promise<string[]> {
  const rnd = rng(seed)
  const root = path.join(tmp, `${mode}-${iter}`)
  const marks = `${root}.marks`
  const p = path.join(root, 'packages', 'p')
  await mkdir(path.join(p, 'src'), { recursive: true })
  await mkdir(marks)
  await writeFile(path.join(root, 'package.json'), '{"name":"fx","workspaces":["packages/*"]}')
  await writeFile(path.join(p, 'package.json'), '{"name":"p"}')

  const ts = Array.from({ length: 3 + Math.floor(rnd() * 6) }, (_, i) => `t${i}`)
  const deps = new Map<string, string[]>()
  const spec = new Map<string, Spec>()
  for (const [i, t] of ts.entries()) {
    deps.set(
      t,
      ts.slice(0, i).filter(() => rnd() < 0.35),
    )
    const r = rnd()
    const kind: Kind = r < 0.4 ? 'pass' : r < 0.55 ? 'fail' : r < 0.85 ? 'flake' : 'timeout'
    const retries = kind === 'pass' ? 0 : Math.floor(rnd() * 3)
    // A timeout task times out on its first `fails` attempts, then passes.
    const fails = kind === 'fail' ? 99 : kind === 'pass' ? 0 : 1 + Math.floor(rnd() * 2)
    spec.set(t, { kind, fails, retries, passes: fails <= retries })
  }
  const pTasks = ts
    .map((t) => {
      const s = spec.get(t)!
      const m = `${marks}/${t}`
      const bad =
        s.kind === 'timeout'
          ? rnd() < 0.5
            ? 'sleep 3'
            : `trap 'exit 0' TERM; sleep 3 & wait; echo PARTIAL > out/${t}.txt; exit 0`
          : `echo PARTIAL > out/${t}.txt; exit 1`
      const cmd = `mkdir -p out && echo x >> ${m} && if [ "$(wc -l < ${m})" -le ${s.fails} ]; then ${bad}; fi; echo ${t} > out/${t}.txt`
      const exec = {
        command: cmd,
        ...(s.retries > 0 ? { retries: s.retries } : {}),
        ...(s.kind === 'timeout' ? { timeout: 500 } : {}),
      }
      return `${t}: { dependsOn: ${JSON.stringify(deps.get(t))}, exec: ${JSON.stringify(exec)},
        cache: { inputs: { files: ['src/${t}.txt'] }, outputs: { files: ['out/${t}.txt'] } } }`
    })
    .join(',\n')
  await writeFile(path.join(p, 'vx.config.mjs'), `export default { tasks: { ${pTasks} } }\n`)
  for (const t of ts) await writeFile(path.join(p, 'src', `${t}.txt`), `${t}\n`)
  gitInitCommit(root, 'init')

  const label = `${mode} #${iter} ${JSON.stringify(Object.fromEntries([...spec].map(([t, s]) => [t, { ...s, deps: deps.get(t) }])))}`
  const broken: string[] = []
  const attempts = async (t: string): Promise<number> =>
    existsSync(`${marks}/${t}`)
      ? (await readFile(`${marks}/${t}`, 'utf8')).split('\n').filter(Boolean).length
      : 0

  errs.length = 0
  const res = await run({
    cwd: root,
    tasks: ts.map((t) => `p#${t}`),
    continueMode: mode,
    log,
    handleSignals: false,
  })
  const status = new Map(res.outcomes.map((o) => [o.node.id.slice(2), o.status]))
  const upstream = (t: string): Set<string> => {
    const out = new Set<string>()
    const stack = [...deps.get(t)!]
    while (stack.length > 0) {
      const d = stack.pop()!
      if (out.has(d)) continue
      out.add(d)
      stack.push(...deps.get(d)!)
    }
    return out
  }
  const anyFailed = ts.some((t) => status.get(t) === 'failed')
  if (res.ok === anyFailed) broken.push(`${label}: ok ${res.ok} with failed=${anyFailed}`)
  for (const t of ts) {
    const s = spec.get(t)!
    const st = status.get(t)
    const n = await attempts(t)
    const failedUp = [...upstream(t)].some((d) => status.get(d) !== 'success')
    if (st === undefined) {
      broken.push(`${label}: ${t} has no outcome`)
      continue
    }
    if (st === 'success') {
      if (!s.passes) broken.push(`${label}: ${t} succeeded but cannot pass`)
      if (n !== s.fails + 1) broken.push(`${label}: ${t} success after ${n} attempts`)
    } else if (st === 'failed') {
      if (s.passes)
        broken.push(`${label}: ${t} failed but should pass (${n} attempts): ${errs.join('|')}`)
      if (n !== s.retries + 1) broken.push(`${label}: ${t} failed after ${n} attempts`)
    } else if (st === 'skipped') {
      if (n !== 0) broken.push(`${label}: ${t} skipped yet started ${n}`)
    } else broken.push(`${label}: ${t} status ${st}`)
    if (failedUp && mode !== 'always' && n !== 0)
      broken.push(`${label}: ${t} started behind a failure`)
    if (mode === 'deps-ok' && !failedUp && st === 'skipped')
      broken.push(`${label}: ${t} skipped with every dep passed`)
    if (mode === 'always' && st === 'skipped') broken.push(`${label}: ${t} skipped under always`)
  }

  // Same keys again: a saved task hits and starts nothing; a failed one
  // reruns. Marker files reset so a rerun counts from 0 (it fails again
  // or passes per its spec; we only read whether it started).
  await rm(marks, { recursive: true })
  await mkdir(marks)
  const again = await run({
    cwd: root,
    tasks: ts.map((t) => `p#${t}`),
    continueMode: mode,
    log,
    handleSignals: false,
  })
  const st2 = new Map(again.outcomes.map((o) => [o.node.id.slice(2), o.status]))
  for (const t of ts) {
    const behind = [...upstream(t)].some((d) => status.get(d) !== 'success')
    const savable = status.get(t) === 'success' && (mode !== 'always' || !behind)
    const n = await attempts(t)
    if (savable && (st2.get(t) !== 'cache-hit' || n !== 0))
      broken.push(`${label}: ${t} passed but second run ${st2.get(t)} after ${n} attempts`)
    if (status.get(t) === 'failed' && st2.get(t) === 'cache-hit')
      broken.push(`${label}: ${t} failed yet hit the cache`)
  }
  return broken
}

for (const [mode, seed, iterations] of [
  ['never', 1, 10],
  ['deps-ok', 2, 10],
  ['always', 3, 10],
] as const) {
  it(`--continue=${mode}: retries x timeout x cache outcomes match the oracle`, async () => {
    const broken: string[] = []
    for (let i = 0; i < iterations; i++) broken.push(...(await scenario(mode, seed * 1000 + i, i)))
    expect(broken.slice(0, 4)).toEqual([])
  }, 300_000)
}
