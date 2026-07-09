// The per-workspace output-fingerprint store (verify-cross-machine §3):
// schema gate, idempotent ingest on the (hash, os, arch, tree) PK, the
// read-time divergence query, server-side re-truncation, tree-only honesty,
// retention pruning, and the IngestStore extraction path.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { OutputFingerprint, RunSummaryRecord } from '@vzn/vx'
import { FpStore, FP_MAX_FILES, type FpReport } from '../src/fp-store.js'
import { IngestStore } from '../src/ingest-store.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vx-fpstore-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fp(
  files: Array<[string, string]>,
  over: Partial<OutputFingerprint> = {},
): OutputFingerprint {
  return {
    tree: `tree-${files.map(([k, h]) => `${k}=${h}`).join(',')}`,
    fileCount: files.length,
    files,
    ...over,
  }
}

function report(over: Partial<FpReport> = {}): FpReport {
  return {
    hash: 'key-1',
    os: 'linux',
    arch: 'x64',
    host: 'ci-7',
    taskId: 'demo#build',
    runId: 'run-1',
    fp: fp([['out.txt', 'aa']]),
    ...over,
  }
}

describe('FpStore', () => {
  it('creates fresh; drops + warns on a schema-version mismatch', () => {
    const s = new FpStore(dir)
    expect(s.ingest([report()])).toBe(1)
    s.close()
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const raw = new Database(path.join(dir, 'fingerprints.db'))
    raw.prepare('UPDATE fp_meta SET value = 99 WHERE key = ?').run('schema')
    raw.close()
    const warnings: string[] = []
    const s2 = new FpStore(dir, undefined, (m) => warnings.push(m))
    expect(warnings.some((w) => w.includes('schema'))).toBe(true)
    expect(s2.hermeticity(50).reportCount).toBe(0) // wiped
    s2.close()
  })

  it('is idempotent on the PK; a different tree on the SAME platform adds a row', () => {
    const s = new FpStore(dir)
    expect(s.ingest([report()])).toBe(1)
    // Re-delivery (same key, platform, tree — even from another run) adds nothing.
    expect(s.ingest([report({ runId: 'run-2' })])).toBe(0)
    // A different tree on the same platform accumulates — the same-platform
    // run-to-run nondeterminism signal.
    expect(s.ingest([report({ runId: 'run-3', fp: fp([['out.txt', 'bb']]) })])).toBe(1)
    expect(s.hermeticity(50).reportCount).toBe(2)
    s.close()
  })

  it('divergence across platforms names the rel, crossPlatform true', () => {
    const s = new FpStore(dir)
    s.ingest([
      report({
        os: 'linux',
        arch: 'x64',
        fp: fp([
          ['dist/app.js', 'aa'],
          ['dist/meta.json', '11'],
        ]),
      }),
      report({
        os: 'darwin',
        arch: 'arm64',
        host: 'mac-2',
        runId: 'run-2',
        fp: fp([
          ['dist/app.js', 'bb'],
          ['dist/meta.json', '11'],
        ]),
      }),
    ])
    const res = s.hermeticity(50)
    expect(res.keysTracked).toBe(1)
    expect(res.reportCount).toBe(2)
    expect(res.divergent.length).toBe(1)
    const d = res.divergent[0]!
    expect(d.hash).toBe('key-1')
    expect(d.taskId).toBe('demo#build')
    expect(d.crossPlatform).toBe(true)
    expect(d.changed).toEqual(['dist/app.js'])
    expect(d.changedComplete).toBe(true)
    expect(d.reports.length).toBe(2)
    expect(d.reports.map((r) => `${r.os}-${r.arch}`).sort()).toEqual(['darwin-arm64', 'linux-x64'])
    s.close()
  })

  it('identical trees across platforms are NOT divergent', () => {
    const s = new FpStore(dir)
    s.ingest([report(), report({ os: 'darwin', arch: 'arm64', runId: 'run-2' })])
    const res = s.hermeticity(50)
    expect(res.divergent).toEqual([])
    expect(res.keysTracked).toBe(1)
    expect(res.reportCount).toBe(2)
    s.close()
  })

  it('same-platform divergence surfaces with crossPlatform false', () => {
    const s = new FpStore(dir)
    s.ingest([report(), report({ runId: 'run-2', fp: fp([['out.txt', 'bb']]) })])
    const d = s.hermeticity(50).divergent[0]!
    expect(d.crossPlatform).toBe(false)
    expect(d.changed).toEqual(['out.txt'])
    s.close()
  })

  it('a tree-only report still detects divergence, flags changed incomplete', () => {
    const s = new FpStore(dir)
    s.ingest([
      report(),
      report({
        os: 'darwin',
        arch: 'arm64',
        runId: 'run-2',
        // Tree-only (the sink's run budget dropped the map).
        fp: { tree: 'other-tree', fileCount: 1, truncated: true },
      }),
    ])
    const d = s.hermeticity(50).divergent[0]!
    expect(d.crossPlatform).toBe(true)
    expect(d.changedComplete).toBe(false)
    expect(d.changed).toEqual([]) // nothing nameable — honesty over guessing
    s.close()
  })

  it('re-truncates a wire map claiming 10k entries to the 500 cap', () => {
    const s = new FpStore(dir)
    const big: Array<[string, string]> = []
    for (let i = 0; i < 10_000; i++) big.push([`f${String(i).padStart(5, '0')}.txt`, `h${i}`])
    s.ingest([report({ fp: { tree: 't-big', fileCount: 10_000, files: big } })])
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
    const raw = new Database(path.join(dir, 'fingerprints.db'), { readonly: true })
    const row = raw
      .prepare('SELECT files, truncated, file_count FROM output_fp WHERE tree = ?')
      .get('t-big') as { files: Uint8Array; truncated: number; file_count: number }
    raw.close()
    // Stored blob is zstd (over the 4 KiB threshold) — decode + count.
    const pairs = JSON.parse(
      Buffer.from(Bun.zstdDecompressSync(row.files)).toString('utf8'),
    ) as unknown[]
    expect(pairs.length).toBe(FP_MAX_FILES)
    expect(row.truncated).toBe(1)
    expect(row.file_count).toBe(10_000)
    s.close()
  })

  it('skips malformed reports (network boundary) without throwing', () => {
    const s = new FpStore(dir)
    const stored = s.ingest([
      report({ hash: '' }),
      report({ fp: { tree: '', fileCount: 1 } }),
      {
        ...report(),
        fp: { tree: 't', fileCount: 1, files: ['not-a-pair'] },
      } as unknown as FpReport,
      report(), // the one valid row
    ])
    expect(stored).toBe(1)
    s.close()
  })

  it('prunes by age horizon and byte ceiling (injected now)', () => {
    const t0 = 1_700_000_000_000
    let now = t0
    const prevMax = process.env['VX_CLOUD_FP_MAX_BYTES']
    try {
      const s = new FpStore(dir, () => now)
      s.ingest([report({ hash: 'old-key' })])
      // 91 days later (default horizon 90d) a new ingest prunes the old row.
      now = t0 + 91 * 24 * 60 * 60 * 1000
      s.ingest([report({ hash: 'new-key', runId: 'run-2' })])
      expect(s.hermeticity(50).reportCount).toBe(1)

      // Byte ceiling: with a tiny cap, oldest rows are deleted until under.
      process.env['VX_CLOUD_FP_MAX_BYTES'] = '150'
      now += 6 * 60 * 1000 // past the prune throttle
      s.ingest([report({ hash: 'newer-key', runId: 'run-3' })])
      // 2 rows × (blob + 64) > 150 → the older row goes.
      const res = s.hermeticity(50)
      expect(res.reportCount).toBe(1)
      s.close()
    } finally {
      if (prevMax === undefined) delete process.env['VX_CLOUD_FP_MAX_BYTES']
      else process.env['VX_CLOUD_FP_MAX_BYTES'] = prevMax
    }
  })
})

function summaryWithFp(
  runId: string,
  os: string,
  arch: string,
  outputFp: OutputFingerprint | undefined,
  hash = 'shared-key',
): RunSummaryRecord {
  const at = Date.now()
  return {
    v: 2,
    run: {
      runId,
      vxVersion: '0.0.0',
      workspaceId: 'ws-fp',
      workspaceName: 'fixture-ws',
      command: 'vx run build --verify=fingerprint',
      requestedTasks: ['build'],
      cachePolicy: 'lR,lW,rR,rW',
      concurrency: 1,
      flow: 'focused',
      commitSha: 'c0ffee',
      branch: 'main',
      dirty: false,
      ci: true,
      ciProvider: 'github',
      host: `host-${os}`,
      os,
      arch,
      tags: {},
    },
    startedAt: at,
    endedAt: at + 100,
    totalDurationMs: 100,
    taskCount: 1,
    failedCount: 0,
    hitCount: 0,
    hitLocalCount: 0,
    hitRemoteCount: 0,
    exitOk: true,
    tasks: [
      {
        taskId: 'demo#build',
        project: 'demo',
        task: 'build',
        status: 'success',
        cacheSource: 'miss',
        exitCode: 0,
        durationMs: 50,
        hash,
        ...(outputFp !== undefined ? { outputFp } : {}),
      },
    ],
  }
}

describe('IngestStore fingerprint extraction', () => {
  it('extracts fp-bearing tasks on ingest; hermeticity() diffs across platforms', () => {
    const store = new IngestStore(dir)
    store.ingest(summaryWithFp('r1', 'linux', 'x64', fp([['dist/a.js', 'aa']])))
    store.ingest(summaryWithFp('r2', 'darwin', 'arm64', fp([['dist/a.js', 'bb']])))
    const res = store.hermeticity('ws-fp', 50)!
    expect(res.divergent.length).toBe(1)
    expect(res.divergent[0]!.changed).toEqual(['dist/a.js'])
    expect(res.divergent[0]!.crossPlatform).toBe(true)
    store.close()
  })

  it('an fp-free (older-core) summary ingests fine and adds no fp rows', () => {
    const store = new IngestStore(dir)
    expect(store.ingest(summaryWithFp('r1', 'linux', 'x64', undefined))).toBe(true)
    const res = store.hermeticity('ws-fp', 50)!
    expect(res).toEqual({ divergent: [], keysTracked: 0, reportCount: 0 })
    store.close()
  })

  it('a re-delivered summary (idempotency gate) adds no fp rows', () => {
    const store = new IngestStore(dir)
    store.ingest(summaryWithFp('r1', 'linux', 'x64', fp([['dist/a.js', 'aa']])))
    expect(store.ingest(summaryWithFp('r1', 'linux', 'x64', fp([['dist/a.js', 'aa']])))).toBe(false)
    expect(store.hermeticity('ws-fp', 50)!.reportCount).toBe(1)
    store.close()
  })
})
