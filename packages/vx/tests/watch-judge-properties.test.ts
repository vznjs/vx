// The change judgement over random edit sequences: files created, edited
// and deleted between judgements, every write with bytes never written
// before, checked against a model that keeps what the loop last saw of
// each path (at the arm: what existed). A judgement starts a cycle iff a
// path that fired differs from that; the cycle is named by a path that
// still exists when one changed (C-94); a file born and gone since the
// arm is no change, one that existed at it and is gone is (C-95).

import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'bun:test'
import { fsClockNow } from '../src/cli/watch-fs.js'
import { ChangeJudge } from '../src/cli/watch-judge.js'
import { rng } from './helpers/rng.js'

it('a judgement starts a cycle exactly when a fired path differs from what the loop last saw', async () => {
  const rnd = rng(9_521)
  const broken: string[] = []
  let writes = 0
  for (let iter = 0; iter < 60; iter++) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-judge-prop-'))
    try {
      const files = Array.from({ length: 5 }, (_, i) => path.join(dir, `f${i}`))
      const known = new Map<string, string | null>()
      for (const f of files) {
        if (rnd() < 0.5) {
          const bytes = `w${writes++}\n`
          await writeFile(f, bytes)
          known.set(f, bytes)
        } else known.set(f, null)
      }
      const listed = new Set(files.filter((f) => known.get(f) !== null))
      const judge = new ChangeJudge({
        workspaceRoot: dir,
        armedAt: fsClockNow(dir),
        held: () => false,
        uncached: () => new Set(),
        existedAtArm: listed,
      })
      for (let round = 0; round < 6; round++) {
        const fired: string[] = []
        for (let op = 1 + Math.floor(rnd() * 4); op > 0; op--) {
          const f = files[Math.floor(rnd() * files.length)]!
          if (existsSync(f) && rnd() < 0.4) await unlink(f)
          else await writeFile(f, `w${writes++}\n`)
          judge.pending.set(f, path.basename(f))
          if (!fired.includes(f)) fired.push(f)
        }
        const now = new Map<string, string | null>()
        for (const f of fired) now.set(f, existsSync(f) ? await readFile(f, 'utf8') : null)
        const changed = fired.filter((f) => now.get(f) !== known.get(f))
        const live = changed.filter((f) => now.get(f) !== null)
        const label = judge.judge()
        const at = `seed 9521 #${iter} round ${round}`
        if (changed.length === 0 && label !== undefined)
          broken.push(`${at}: ${label} with nothing changed`)
        if (changed.length > 0 && label === undefined)
          broken.push(`${at}: no cycle for ${changed.map((f) => path.basename(f)).join(', ')}`)
        if (label !== undefined && !changed.some((f) => path.basename(f) === label))
          broken.push(`${at}: named ${label}, which did not change`)
        if (label !== undefined && live.length > 0 && !live.some((f) => path.basename(f) === label))
          broken.push(`${at}: named gone ${label} over a live change`)
        for (const f of fired) known.set(f, now.get(f)!)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  expect(broken).toEqual([])
}, 60_000)
