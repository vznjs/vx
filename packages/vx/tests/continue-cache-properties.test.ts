// What a run behind a failure saves, over seeded random graphs, end to end:
// the stale-hit property. Each graph runs three times. A healthy run warms
// every entry; then some inputs change and some tasks fail (a flag outside
// every key) under one `--continue` mode; then a healthy run with the same
// keys. That run must execute exactly the changed tasks the failing run did
// not save, and every output must hold its healthy bytes: an output is its
// input plus its deps' outputs, and a failure writes PARTIAL, so a saved
// partial tree reads wrong. `g`'s tasks have no cache and sit apart, so
// their failure moves no key: a hit above one is restored ahead of it (the
// shape of C-1). Under `always`, a task behind any failure, through hits
// too, is not saved; otherwise a task that ran is saved, since every dep it
// read passed (C-80).

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import type { ContinueMode } from '../src/graph/index.js'
import { gitInitCommit } from './helpers/workspace.js'
import { rng } from './helpers/rng.js'

const silent: Logger = {
  status: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
}

let tmp = ''
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-cprop-'))
})
afterAll(() => rm(tmp, { recursive: true, force: true }))

async function scenario(mode: ContinueMode, seed: number, iter: number): Promise<string[]> {
  const rnd = rng(seed)
  const root = path.join(tmp, `${mode}-${iter}`)
  const flags = `${root}.flags`
  const gOut = `${root}.g`
  const p = path.join(root, 'packages', 'p')
  const g = path.join(root, 'packages', 'g')
  await mkdir(path.join(p, 'src'), { recursive: true })
  await mkdir(g, { recursive: true })
  await mkdir(flags)
  await mkdir(gOut)
  await writeFile(path.join(root, 'package.json'), '{"name":"fx","workspaces":["packages/*"]}')
  await writeFile(path.join(p, 'package.json'), '{"name":"p"}')
  await writeFile(path.join(g, 'package.json'), '{"name":"g"}')

  const gs = Array.from({ length: 1 + Math.floor(rnd() * 2) }, (_, i) => `x${i}`)
  const ps = Array.from({ length: 2 + Math.floor(rnd() * 6) }, (_, i) => `t${i}`)
  const deps = new Map<string, string[]>()
  for (const [i, t] of ps.entries()) {
    const d = ps.slice(0, i).filter(() => rnd() < 0.4)
    // Early tasks lean on `g`, later ones change: a changed task above a
    // hit above a failing `g` is the shape the release order guards.
    for (const x of gs) if (rnd() < (i < 2 ? 0.6 : 0.2)) d.push(`g#${x}`)
    deps.set(t, d)
  }
  const gTasks = gs
    .map(
      (x) =>
        `${x}: { exec: { command: 'if [ -e ${flags}/g-${x} ]; then sleep 0.3; echo PARTIAL > ${gOut}/${x}; exit 1; fi; echo GOOD-${x} > ${gOut}/${x}' } }`,
    )
    .join(',\n')
  await writeFile(path.join(g, 'vx.config.mjs'), `export default { tasks: { ${gTasks} } }\n`)
  const read = (d: string): string =>
    d.startsWith('g#') ? `${gOut}/${d.slice(2)}` : `out/${d}.txt`
  const pTasks = ps
    .map((t) => {
      const ins = ['src/' + t + '.txt', ...deps.get(t)!.map(read)].join(' ')
      const cmd = `mkdir -p out && if [ -e ${flags}/${t} ]; then echo PARTIAL > out/${t}.txt; exit 1; fi; cat ${ins} > out/${t}.txt`
      return `${t}: { dependsOn: ${JSON.stringify(deps.get(t))}, exec: { command: ${JSON.stringify(cmd)} },
        cache: { inputs: { files: ['src/${t}.txt'] }, outputs: { files: ['out/${t}.txt'] } } }`
    })
    .join(',\n')
  await writeFile(path.join(p, 'vx.config.mjs'), `export default { tasks: { ${pTasks} } }\n`)
  for (const t of ps) await writeFile(path.join(p, 'src', `${t}.txt`), `${t}-v1\n`)
  gitInitCommit(root, 'init')

  const runAll = (continueMode?: ContinueMode) =>
    run({
      cwd: root,
      tasks: ps.map((t) => `p#${t}`),
      ...(continueMode !== undefined ? { continueMode } : {}),
      log: silent,
      handleSignals: false,
    })
  const broken: string[] = []
  const label = `${mode} #${iter} deps ${JSON.stringify(Object.fromEntries(deps))}`

  const warm = await runAll()
  if (!warm.ok) return [`${label}: the warm run failed`]

  // Change some inputs (their tasks and dependants miss) and fail some tasks.
  const changed = new Set(ps.filter((_, i) => rnd() < 0.1 + 0.12 * i))
  for (const t of changed) await writeFile(path.join(p, 'src', `${t}.txt`), `${t}-v2\n`)
  const failing = [
    ...ps.filter(() => rnd() < 0.2),
    ...gs.filter(() => rnd() < 0.5).map((x) => `g-${x}`),
  ]
  for (const f of failing) await writeFile(path.join(flags, f), '')
  const missed = new Set<string>()
  for (const t of ps) if (changed.has(t) || deps.get(t)!.some((d) => missed.has(d))) missed.add(t)

  const first = await runAll(mode)
  const status = new Map(first.outcomes.map((o) => [o.node.id, o.status]))
  const bad = (id: string): boolean => {
    const s = status.get(id)
    return s === 'failed' || s === 'skipped' || s === 'aborted'
  }
  const behindFailure = (t: string): boolean => {
    const stack = [...deps.get(t)!]
    const seen = new Set<string>()
    while (stack.length > 0) {
      const d = stack.pop()!
      if (seen.has(d)) continue
      seen.add(d)
      const id = d.startsWith('g#') ? d : `p#${d}`
      if (bad(id)) return true
      if (!d.startsWith('g#')) stack.push(...deps.get(d)!)
    }
    return false
  }
  const saved = new Set(
    ps.filter(
      (t) => status.get(`p#${t}`) === 'success' && (mode !== 'always' || !behindFailure(t)),
    ),
  )

  for (const f of failing) await rm(path.join(flags, f))
  const second = await runAll()
  if (!second.ok) broken.push(`${label}: the healthy run failed`)
  const ran = ps.filter(
    (t) => second.outcomes.find((o) => o.node.id === `p#${t}`)?.status === 'success',
  )
  const expected = ps.filter((t) => missed.has(t) && !saved.has(t))
  if (JSON.stringify(ran) !== JSON.stringify(expected))
    broken.push(
      `${label}: ran ${ran.join(',')}, expected ${expected.join(',')} (changed ${[...changed].join(',')}, failing ${failing.join(',')}, first ${JSON.stringify(Object.fromEntries(status))})`,
    )
  const healthy = new Map<string, string>()
  const content = (d: string): string => {
    if (d.startsWith('g#')) return `GOOD-${d.slice(2)}\n`
    const known = healthy.get(d)
    if (known !== undefined) return known
    const v = `${d}-${changed.has(d) ? 'v2' : 'v1'}\n` + deps.get(d)!.map(content).join('')
    healthy.set(d, v)
    return v
  }
  for (const t of ps) {
    const got = await readFile(path.join(p, 'out', `${t}.txt`), 'utf8')
    if (got !== content(t))
      broken.push(
        `${label}: out/${t}.txt holds ${JSON.stringify(got)} (failing ${failing.join(',')})`,
      )
  }
  return broken
}

// `always` takes twice the graphs: it alone holds the release order a
// restore-tier hit keeps (item 963), and its shape is the rarest.
for (const [mode, seed, iterations] of [
  ['always', 1, 12],
  ['deps-ok', 2, 6],
  ['never', 3, 6],
] as const) {
  it(`a healthy run after a failing --continue=${mode} run replays no partial tree`, async () => {
    const broken: string[] = []
    for (let i = 0; i < iterations; i++) broken.push(...(await scenario(mode, seed * 1000 + i, i)))
    expect(broken.slice(0, 3)).toEqual([])
  }, 120_000)
}
