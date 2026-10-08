// A cache hit replays the task's stdout from the SQLite row. The volume
// case is pinned by the artifact round-trip; this is the encoding case
// (parity doc L7): a NUL byte, `\r` progress rewrites and raw ANSI must
// come back byte-identical to what the live run streamed. bun:sqlite
// binds and reads TEXT with an explicit length, so a NUL neither ends
// the value nor is escaped.

import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { packArtifact, scanArtifact } from '../src/cache/archive.js'
import { streamOf } from './helpers/stream.js'

const EXPECTED = 'a\u0000b\rprogress 50%\r\u001b[31mred\u001b[0m\n'

function capturing(): { log: Logger; out: string[] } {
  const out: string[] = []
  const log: Logger = {
    status() {},
    taskStdout(_node, chunk) {
      out.push(chunk)
    },
    taskStderr() {},
    taskComplete() {},
  }
  return { log, out }
}

describe('cache-hit stdout replay fidelity', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-replay-' })
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            emit: {
              exec: { command: 'sh emit.sh' },
              cache: { inputs: { files: ['emit.sh'] }, outputs: { files: [] } },
            },
          },
        }
      `,
    )
    await writeFile(
      path.join(dir, 'emit.sh'),
      "printf 'a\\000b\\rprogress 50%%\\r\\033[31mred\\033[0m\\n'\n",
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('a NUL, CR rewrites and ANSI replay byte-identical from the row', async () => {
    const live = capturing()
    const r1 = await run({
      cwd: root,
      tasks: ['emit'],
      projects: ['app'],
      log: live.log,
      handleSignals: false,
    })
    expect(r1.ok).toBe(true)
    expect(live.out.join('')).toBe(EXPECTED)

    const replay = capturing()
    const r2 = await run({
      cwd: root,
      tasks: ['emit'],
      projects: ['app'],
      log: replay.log,
      handleSignals: false,
    })
    expect(r2.ok).toBe(true)
    expect(r2.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
    expect(replay.out.join('')).toBe(EXPECTED)
  })
})

describe('cache-hit replay keeps both streams in order', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-replay-order-' })
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            emit: {
              exec: { command: 'sh emit.sh' },
              cache: { inputs: { files: ['emit.sh'] }, outputs: { files: [] } },
            },
          },
        }
      `,
    )
    // The sleeps order the two pipes; RS + e in stdout is the task's own text.
    await writeFile(
      path.join(dir, 'emit.sh'),
      "printf 'one\\n'; sleep 0.2; printf 'two\\n' >&2; sleep 0.2; printf 'thr\\036e\\n'\n",
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const streams = (): { log: Logger; seen: string[] } => {
    const seen: string[] = []
    const log: Logger = {
      status() {},
      taskStdout(_node, chunk) {
        seen.push(`out:${chunk}`)
      },
      taskStderr(_node, chunk) {
        seen.push(`err:${chunk}`)
      },
      taskComplete() {},
    }
    return { log, seen }
  }
  const opts = { tasks: ['emit'], projects: ['app'], handleSignals: false }

  it('stderr between two stdout lines replays between them', async () => {
    const live = streams()
    expect((await run({ cwd: root, ...opts, log: live.log })).ok).toBe(true)
    const expected = ['out:one\n', 'err:two\n', 'out:thr\u001ee\n']
    expect(live.seen).toEqual(expected)

    const replay = streams()
    const r2 = await run({ cwd: root, ...opts, log: replay.log })
    expect(r2.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
    expect(replay.seen).toEqual(expected)
  })
})

// A leading U+FEFF is output too. A default `TextDecoder` drops one at a
// stream's start, so the live run printed `out` without it, the entry
// stored that, and the artifact's scan dropped it again on ingest.
describe('a leading byte-order mark', () => {
  let root: string
  beforeEach(async () => {
    root = await makeWorkspace({ prefix: 'vx-replay-bom-' })
    const dir = await addProject(
      root,
      'app',
      `
        export default {
          tasks: {
            emit: {
              exec: { command: 'sh emit.sh' },
              cache: { inputs: { files: ['emit.sh'] }, outputs: { files: [] } },
            },
          },
        }
      `,
    )
    await writeFile(
      path.join(dir, 'emit.sh'),
      "printf '\\357\\273\\277out\\n'\nprintf '\\357\\273\\277err\\n' >&2\n",
    )
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const both = () => {
    const out: string[] = []
    const err: string[] = []
    const log: Logger = {
      status() {},
      taskStdout: (_n, c) => void out.push(c),
      taskStderr: (_n, c) => void err.push(c),
      taskComplete() {},
    }
    return { log, text: () => [out.join(''), err.join('')] }
  }

  it('is printed by the run and replayed by the hit, on both streams', async () => {
    const live = both()
    const opts = { cwd: root, tasks: ['emit'], projects: ['app'], handleSignals: false }
    const r1 = await run({ ...opts, log: live.log })
    expect(r1.ok).toBe(true)
    expect(live.text()).toEqual(['﻿out\n', '﻿err\n'])

    const replay = both()
    const r2 = await run({ ...opts, log: replay.log })
    expect(r2.outcomes.map((o) => o.status)).toEqual(['cache-hit'])
    expect(replay.text()).toEqual(['﻿out\n', '﻿err\n'])
  })

  it("is read back out of an artifact's stdout entry, as an ingest reads it", async () => {
    const tar = await packArtifact({ key: 'k', stdout: '﻿out\n', outputs: new Map() })
    expect((await scanArtifact(streamOf(tar))).stdout).toBe('﻿out\n')
  })
})
