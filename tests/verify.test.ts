// Provable cache correctness — Phase 1 (determinism). `vx run --verify`
// re-executes each cacheable task after its save and content-compares the
// outputs: a divergence proves the task is non-hermetic (its cache entry
// would replay arbitrary past bytes) and fails the run. A pure side-channel:
// never folded into a cache key. See docs/design/cache-correctness-2026-07.md.

import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeLocalWorkspace } from './helpers/local-workspace.js'
import type { RemoteCacheLayer } from '../src/cache/index.js'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import type { TaskOutcome } from '../src/graph/index.js'
import {
  foldFingerprint,
  formatVerifySection,
  undeclaredInputPaths,
} from '../src/orchestrator/verify.js'
import { xxh3hex } from '../src/util/index.js'
import { sandboxReportingReliable } from './helpers/sandbox-gate.js'

const TIMEOUT = 20_000

interface Fixture {
  root: string
  out: string[]
  err: string[]
}
let fixture: Fixture

const capturingLogger = (f: Fixture): Logger => ({
  status() {},
  taskStdout(_n, c) {
    f.out.push(c)
  },
  taskStderr(_n, c) {
    f.err.push(c)
  },
  taskComplete() {},
})

async function makeWorkspace(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vx-verify-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }, null, 2),
  )
  await writeLocalWorkspace(root)
  await mkdir(path.join(root, 'packages'), { recursive: true })
  const git = (...a: string[]) => {
    const p = Bun.spawnSync({ cmd: ['git', '-c', 'commit.gpgsign=false', ...a], cwd: root })
    if (p.exitCode !== 0) throw new Error(`git ${a.join(' ')}`)
  }
  git('init', '-q')
  git('config', 'user.email', 't@vx.local')
  git('config', 'user.name', 'vx')
  return { root, out: [], err: [] }
}

async function addProject(root: string, name: string, config: string): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '0.0.0' }, null, 2),
  )
  await writeFile(path.join(dir, 'vx.config.mjs'), config)
  return dir
}

const DETERMINISM = {
  determinism: true,
  inputs: false,
  fingerprint: true,
  allow: new Set<string>(),
}

/** A real (in-memory) remote layer — so the remote axes are NOT inert. */
function inMemoryRemote(): { layer: RemoteCacheLayer; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>()
  return {
    store,
    layer: {
      async has(hash) {
        return store.has(hash)
      },
      async get(hash) {
        const body = store.get(hash)
        if (!body) return null
        return { body: body.slice().buffer as ArrayBuffer, durationMs: 1 }
      },
      async put(hash, body) {
        store.set(hash, body instanceof Uint8Array ? new Uint8Array(body) : new Uint8Array(body))
      },
    },
  }
}

/** A cacheable task whose output is written by `cmd` (a node -e expression body). */
const project = (cmd: string, outputs = "['out.txt']") =>
  `export default {
    tasks: {
      run: {
        exec: { command: ${JSON.stringify(`node -e '${cmd}'`)} },
        cache: { inputs: { files: ['package.json'] }, outputs: { files: ${outputs} } },
      },
    },
  }`

describe('vx run --verify (determinism)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'proves a deterministic task safe',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'proven-deterministic' })
    },
    TIMEOUT,
  )

  it(
    'catches a non-deterministic task, names the diverging output, fails the run',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt",String(Math.random()))'),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      const v = r.outcomes[0]!.verify
      expect(v?.kind).toBe('nondeterministic')
      if (v?.kind === 'nondeterministic') expect(v.changed).toContain('out.txt')
    },
    TIMEOUT,
  )

  it(
    'reports a cacheable task with no declared outputs as no-outputs (nothing to replay)',
    async () => {
      await addProject(fixture.root, 'a', project('process.stdout.write("hi")', '[]'))
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'no-outputs' })
    },
    TIMEOUT,
  )

  it(
    '--verify-allow exempts a known-nondeterministic task from failing the run',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt",String(Math.random()))'),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: { determinism: true, inputs: false, fingerprint: true, allow: new Set(['a#run']) },
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify?.kind).toBe('allowed-nondeterministic')
    },
    TIMEOUT,
  )

  it(
    'a cache hit is not-verified; --verify never changes the cache key (hits a plain entry)',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      // Plain run saves a normal entry.
      const plain = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(plain.outcomes[0]!.status).toBe('success')
      // A --verify run HITS that entry — proving the key is byte-identical
      // with and without --verify — and the hit is flagged not-verified.
      const verified = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(verified.outcomes[0]!.status).toBe('cache-hit')
      expect(verified.outcomes[0]!.verify).toEqual({ kind: 'not-verified' })
    },
    TIMEOUT,
  )

  it(
    '--force re-executes a warm graph so it can be verified',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      // --force = reads off, writes on → re-executes → verifiable.
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        cache: { localRead: false, localWrite: true, remoteRead: false, remoteWrite: true },
        verify: DETERMINISM,
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(r.outcomes[0]!.status).toBe('success')
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'proven-deterministic' })
    },
    TIMEOUT,
  )

  it(
    'a re-run that fails under identical inputs is rerun-failed (nondeterministic by definition), fails the run',
    async () => {
      // Attempt 1: no marker → write out.txt + a marker OUTSIDE the
      // declared outputs, exit 0 (success, saves). The verify re-run
      // cleans out.txt but the marker survives → the command sees it and
      // exits 1 → a re-run that fails on identical inputs.
      await addProject(
        fixture.root,
        'a',
        project(
          'const fs=require("fs");if(fs.existsSync("marker")){process.exit(1)}fs.writeFileSync("out.txt","ok");fs.writeFileSync("marker","1")',
        ),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      // Attempt 1 succeeded, so the task's own status stays success…
      expect(r.outcomes[0]!.status).toBe('success')
      // …but the verify re-run failed, which the verdict records + fails the run.
      const v = r.outcomes[0]!.verify
      expect(v?.kind).toBe('rerun-failed')
      if (v?.kind === 'rerun-failed') expect(v.exitCode).toBe(1)
    },
    TIMEOUT,
  )

  it(
    'catches divergent bytes even at EQUAL size + mtime (the memo must not vouch)',
    async () => {
      // Reproducible-build practice normalizes output mtimes; a divergence
      // with equal size + equal mtime is exactly what Cache.hashFile's
      // mtime+size memo would blindly vouch for. The fingerprint must hash
      // BYTES. First attempt writes AAAA, the re-run BBBB (marker-toggled),
      // both 4 bytes with mtime pinned to the same second.
      await addProject(
        fixture.root,
        'a',
        project(
          'const fs=require("fs");const b=fs.existsSync("m")?"BBBB":"AAAA";fs.writeFileSync("m","");fs.writeFileSync("out.txt",b);fs.utimesSync("out.txt",1000,1000)',
        ),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      const v = r.outcomes[0]!.verify
      expect(v?.kind).toBe('nondeterministic')
      if (v?.kind === 'nondeterministic') expect(v.changed).toContain('out.txt')
    },
    TIMEOUT,
  )

  it(
    "the verify re-run's stray outputs never survive — disk == the cached artifact",
    async () => {
      // A task whose output FILENAME diverges: attempt 1 writes out-a.txt,
      // the re-run out-b.txt. The post-verify restore must clean the declared
      // globs first (restoreOutputs alone never deletes strays), so exactly
      // attempt 1's file remains regardless of the (allowed) verdict.
      await addProject(
        fixture.root,
        'a',
        project(
          'const fs=require("fs");const n=fs.existsSync("m")?"out-b.txt":"out-a.txt";fs.writeFileSync("m","");fs.writeFileSync(n,"x")',
          "['out-*.txt']",
        ),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: { determinism: true, inputs: false, fingerprint: true, allow: new Set(['a#run']) },
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify?.kind).toBe('allowed-nondeterministic')
      const { readdirSync } = await import('node:fs')
      const outs = readdirSync(path.join(fixture.root, 'packages', 'a'))
        .filter((f) => /^out-.*\.txt$/.test(f))
        .sort()
      expect(outs).toEqual(['out-a.txt'])
    },
    TIMEOUT,
  )

  it(
    'rejects --verify with a no-write cache policy (nothing would be verified)',
    async () => {
      await addProject(fixture.root, 'a', project('require("fs").writeFileSync("out.txt","x")'))
      await expect(
        run({
          cwd: fixture.root,
          tasks: ['run'],
          projects: ['a'],
          cache: { localRead: false, localWrite: false, remoteRead: false, remoteWrite: false },
          verify: DETERMINISM,
          log: capturingLogger(fixture),
        }),
      ).rejects.toThrow(/--verify needs the LOCAL cache write axis/)
    },
    TIMEOUT,
  )

  it(
    'rejects --verify with a remote-only write policy and no remote layer',
    async () => {
      // `remote:rw` with nothing to serve it writes NOWHERE, but the write
      // axis read as on: the task's outputs were cleaned before exec, then
      // the verifier cleaned them AGAIN and restored an artifact `save()`
      // never wrote — destroying a SUCCESSFUL build's tree and reporting it
      // failed with an internal CorruptArtifactError. Refuse up front, so
      // nothing runs and nothing is wiped.
      const dir = await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      await writeFile(path.join(dir, 'out.txt'), 'PRE-EXISTING')
      await expect(
        run({
          cwd: fixture.root,
          tasks: ['run'],
          projects: ['a'],
          cache: { localRead: true, localWrite: false, remoteRead: true, remoteWrite: true },
          verify: DETERMINISM,
          log: capturingLogger(fixture),
        }),
      ).rejects.toThrow(/--verify needs the LOCAL cache write axis/)
      // The refusal happens before any task runs, so the tree is untouched.
      expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('PRE-EXISTING')
    },
    TIMEOUT,
  )

  it(
    'rejects --verify with a remote-only write policy even WITH a remote layer',
    async () => {
      // The half the inert-axis fix missed, and the one its error message
      // sent people INTO: with a real remote, `remote:rw` is not inert —
      // `save` uploads the artifact — but `local:` means `Cache.save`
      // wrote no local artifact, and `restoreOutputs` is a LOCAL extraction
      // on every layer. So verify cleaned a SUCCESSFUL build's declared
      // outputs and then died on the missing artifact: exit 1, empty tree,
      // artifact sitting on the remote. Refuse up front instead.
      const dir = await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      await writeFile(path.join(dir, 'out.txt'), 'PRE-EXISTING')
      const remote = inMemoryRemote()
      await expect(
        run({
          cwd: fixture.root,
          tasks: ['run'],
          projects: ['a'],
          remoteCache: remote.layer,
          cache: { localRead: false, localWrite: false, remoteRead: true, remoteWrite: true },
          verify: DETERMINISM,
          log: capturingLogger(fixture),
        }),
      ).rejects.toThrow(/--verify needs the LOCAL cache write axis/)
      expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('PRE-EXISTING')
      expect(remote.store.size).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'accepts --verify with local writes on and local reads off (the fixed recipe)',
    async () => {
      // The control for the gate above: `--cache=local:w,remote:rw` is what
      // the error message now points at, so it had better work — verify
      // runs, proves determinism, and leaves the built tree on disk.
      const dir = await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      const remote = inMemoryRemote()
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        remoteCache: remote.layer,
        cache: { localRead: false, localWrite: true, remoteRead: true, remoteWrite: true },
        verify: DETERMINISM,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'proven-deterministic' })
      expect(readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('stable')
    },
    TIMEOUT,
  )

  it(
    'a remote-only write policy with no remote layer does not clean outputs before exec',
    async () => {
      // The same inert-axis bug outside `--verify`: `willWrite` believed a
      // save would happen, so the pre-exec output wipe fired for a run that
      // caches nothing — `--no-cache`'s documented "leave the tree alone"
      // contract, broken by a policy that is effectively --no-cache.
      const dir = await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("kept.txt","new")', "['*.txt']"),
      )
      await writeFile(path.join(dir, 'stray.txt'), 'UNTOUCHED')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        cache: { localRead: true, localWrite: false, remoteRead: true, remoteWrite: true },
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(true)
      expect(readFileSync(path.join(dir, 'stray.txt'), 'utf8')).toBe('UNTOUCHED')
    },
    TIMEOUT,
  )

  it(
    'a plain run (no --verify) attaches no verdict',
    async () => {
      await addProject(
        fixture.root,
        'a',
        project('require("fs").writeFileSync("out.txt","stable")'),
      )
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(r.outcomes[0]!.verify).toBeUndefined()
    },
    TIMEOUT,
  )
})

describe('foldFingerprint (pure)', () => {
  it('tree digest + files are stable across insertion order', () => {
    const a = new Map([
      ['x.txt', '01'],
      ['a.txt', '02'],
      ['m/n.txt', '03'],
    ])
    const b = new Map([
      ['m/n.txt', '03'],
      ['x.txt', '01'],
      ['a.txt', '02'],
    ])
    expect(foldFingerprint(a)).toEqual(foldFingerprint(b))
    expect(foldFingerprint(a).files).toEqual([
      ['a.txt', '02'],
      ['m/n.txt', '03'],
      ['x.txt', '01'],
    ])
  })

  it('\\0 fold boundaries: a shifted key/hash split cannot alias', () => {
    // Same concatenated characters, different (key, hash) split → different trees.
    expect(foldFingerprint(new Map([['ab', 'c']])).tree).not.toBe(
      foldFingerprint(new Map([['a', 'bc']])).tree,
    )
    // Same for the entry boundary: one entry vs an empty-hash pair.
    expect(foldFingerprint(new Map([['a', 'b']])).tree).not.toBe(
      foldFingerprint(new Map([['ab', '']])).tree,
    )
  })

  it('cap truncation is deterministic (sorted first-N) and fileCount stays honest', () => {
    const entries: Array<[string, string]> = []
    for (let i = 0; i < 7; i++) entries.push([`f${i}.txt`, `h${i}`])
    const shuffled = [entries[4]!, entries[0]!, entries[6]!, entries[2]!].concat([
      entries[1]!,
      entries[5]!,
      entries[3]!,
    ])
    const fp = foldFingerprint(new Map(shuffled), 5)
    expect(fp.fileCount).toBe(7)
    expect(fp.truncated).toBe(true)
    expect(fp.files!.length).toBe(5)
    expect(fp.files!.map(([k]) => k)).toEqual(['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'])
    // The tree folds ALL entries — truncation never changes detection.
    expect(fp.tree).toBe(foldFingerprint(new Map(entries)).tree)
    // Deterministic: a permuted input truncates to the same subset + tree.
    expect(foldFingerprint(new Map(entries), 5)).toEqual(fp)
  })

  it('empty map: empty-fold tree, zero fileCount, empty files, not truncated', () => {
    const fp = foldFingerprint(new Map())
    expect(fp).toEqual({ tree: xxh3hex(''), fileCount: 0, files: [] })
  })
})

describe('vx run --verify=fingerprint (cross-machine feed)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })
})

describe('undeclaredInputPaths (pure)', () => {
  it('extracts the bracketed abs path and makes it workspace-relative', () => {
    const ws = '/work/space'
    const v = [
      { line: `openat(secret.txt) = -1 ENOENT  [${ws}/pkg/a/secret.txt]` },
      { line: `openat(other) = -1 ENOENT  [${ws}/pkg/b/other.env]` },
    ]
    expect(undeclaredInputPaths(v, ws)).toEqual(['pkg/a/secret.txt', 'pkg/b/other.env'])
  })

  it('dedups + sorts and falls back to the raw line when no bracket is present', () => {
    const ws = '/w'
    const v = [
      { line: `openat(x) = -1 ENOENT  [${ws}/z.txt]` },
      { line: `openat(x) = -1 ENOENT  [${ws}/z.txt]` }, // dup
      { line: `openat(x) = -1 ENOENT  [${ws}/a.txt]` },
      { line: 'sandbox: some macos syscall line with no bracket' }, // fallback
    ]
    expect(undeclaredInputPaths(v, ws)).toEqual([
      'a.txt',
      'sandbox: some macos syscall line with no bracket',
      'z.txt',
    ])
  })
})

describe('formatVerifySection (pure)', () => {
  type V = NonNullable<TaskOutcome['verify']>
  const mk = (id: string, verify: V | undefined): TaskOutcome =>
    ({
      node: { id },
      status: 'success',
      exitCode: 0,
      durationMs: 0,
      ...(verify ? { verify } : {}),
    }) as unknown as TaskOutcome

  it('returns nothing when no outcome carries a verdict', () => {
    expect(formatVerifySection([])).toEqual([])
    expect(formatVerifySection([mk('p#plain', undefined)])).toEqual([])
  })

  it('tallies each verdict class and renders one block per failure', () => {
    const outcomes = [
      mk('p#det', { kind: 'proven-deterministic' }),
      mk('p#complete', { kind: 'proven-complete' }),
      mk('p#nondet', { kind: 'nondeterministic', changed: ['a.txt', 'b.txt'] }),
      mk('p#leaky', { kind: 'undeclared-inputs', paths: ['secret.txt'] }),
      mk('p#reran', { kind: 'rerun-failed', exitCode: 3 }),
      mk('p#allowed', { kind: 'allowed-nondeterministic', changed: ['c.txt'] }),
      mk('p#noout', { kind: 'no-outputs' }),
      mk('p#hit', { kind: 'not-verified' }),
    ]
    const text = formatVerifySection(outcomes).join('\n')

    // Counts line: 2 proven (deterministic + complete), 3 unsafe
    // (nondeterministic + undeclared-inputs + rerun-failed), 2 n/a
    // (allowed + no-outputs), 1 not-verified.
    expect(text).toContain('Verify:   2 proven · 3 unsafe · 2 n/a · 1 not-verified')

    // Failure blocks, one per unsafe/allowed verdict.
    expect(text).toContain('✗ p#nondet — nondeterministic')
    expect(text).toContain('changed: a.txt, b.txt')
    expect(text).toContain('✗ p#leaky — read undeclared inputs')
    expect(text).toContain('secret.txt')
    expect(text).toContain('add them to cache.inputs.files / workspaceFiles')
    expect(text).toContain('✗ p#reran — verify re-run failed (exit 3)')
    expect(text).toContain('⚠ p#allowed — nondeterministic (allowed)')

    // Proven / no-outputs / not-verified never get a block.
    expect(text).not.toContain('p#det —')
    expect(text).not.toContain('p#complete')
    expect(text).not.toContain('p#noout')
    expect(text).not.toContain('p#hit')
  })

  it('omits the path line for an undeclared-inputs verdict with no named paths', () => {
    const text = formatVerifySection([mk('p#x', { kind: 'undeclared-inputs', paths: [] })]).join(
      '\n',
    )
    expect(text).toContain('✗ p#x — read undeclared inputs')
    expect(text).toContain('add them to cache.inputs.files / workspaceFiles')
    // The "        <paths>" line is skipped when paths is empty.
    expect(text).not.toMatch(/read undeclared inputs\n {8}\n/)
  })
})

// Phase 2 (input-completeness) needs the OS sandbox. CI installs it and sets
// VX_REQUIRE_SANDBOX, so an unavailable runtime FAILS this file there rather
// than deleting the proof's coverage under a green check; a dev host without
// bwrap/strace still skips. Same gate as tests/sandbox-runtime.test.ts, shared
// so the two cannot drift about what the rule is.
// The `undeclared-inputs` verdict IS the report, so this block needs
// reporting reliability, not merely an available sandbox.
const sandboxOk = await sandboxReportingReliable('verify inputs tests')

/** A cacheable task that reads `readCmd` (a node -e body) and writes out.txt. */
const inputProject = (readExpr: string, inputs = "['src/**','package.json']") =>
  `export default {
    tasks: {
      run: {
        exec: { command: ${JSON.stringify(`node -e '${readExpr}'`)} },
        cache: { inputs: { files: ${inputs} }, outputs: { files: ['out.txt'] } },
      },
    },
  }`

const INPUTS = { determinism: false, inputs: true, fingerprint: false, allow: new Set<string>() }

describe.skipIf(!sandboxOk)('vx run --verify=inputs (input-completeness)', () => {
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'proves a task whose declared inputs are complete',
    async () => {
      const dir = await addProject(
        fixture.root,
        'a',
        inputProject('require("fs").writeFileSync("out.txt","ok")'),
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: INPUTS,
        log: capturingLogger(fixture),
      })
      if (!r.ok) {
        console.log(
          'DEBUG clean-verify fail:',
          JSON.stringify({
            verify: r.outcomes[0]!.verify,
            lines: r.outcomes[0]!.sandboxViolationLines,
            status: r.outcomes[0]!.status,
          }),
        )
      }
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'proven-complete' })
    },
    TIMEOUT,
  )

  it(
    'a remote-only task is reported unverifiable, not silently green',
    async () => {
      // verify=inputs pins placement local, and a `remote: 'only'` task with
      // no remote executor no-ops — there is no execution to sandbox, so the
      // proof cannot cover it. The verdict must SAY so; a silent noop reads
      // as a green proof over ground the proof never touched.
      const dir = await addProject(
        fixture.root,
        'a',
        `export default {
          tasks: {
            run: {
              exec: { command: 'echo hi > out.txt', remote: 'only' },
              cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
            },
          },
        }`,
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: INPUTS,
        log: capturingLogger(fixture),
      })
      // Unverifiable is a WARNING, not a failure — the task also never
      // executes locally by definition, so nothing red.
      expect(r.ok).toBe(true)
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'unverifiable-remote-only' })

      // CONTROL: a plain run of the same task carries no verdict at all —
      // the report exists only when a proof was requested.
      const plain = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      expect(plain.ok).toBe(true)
      expect(plain.outcomes[0]!.verify).toBeUndefined()
    },
    TIMEOUT,
  )

  it(
    'catches a read outside the declared inputs, names the path, fails the run',
    async () => {
      const dir = await addProject(
        fixture.root,
        'a',
        // Reads secret.txt (NOT under src/** or package.json). The read is
        // denied under the sandbox; the attempt is still flagged.
        inputProject(
          'const fs=require("fs");let s="d";try{s=fs.readFileSync("secret.txt","utf8")}catch(e){}fs.writeFileSync("out.txt",s)',
        ),
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      await writeFile(path.join(dir, 'secret.txt'), 'SECRET')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: INPUTS,
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      const v = r.outcomes[0]!.verify
      expect(v?.kind).toBe('undeclared-inputs')
      if (v?.kind === 'undeclared-inputs') {
        expect(v.paths.some((p) => p.endsWith('secret.txt'))).toBe(true)
      }
    },
    TIMEOUT,
  )

  it(
    'a cache hit is not-verified under --verify=inputs (never re-runs)',
    async () => {
      const cfg = inputProject('require("fs").writeFileSync("out.txt","ok")')
      const dir = await addProject(fixture.root, 'a', cfg)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        log: capturingLogger(fixture),
      })
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: INPUTS,
        log: capturingLogger({ root: fixture.root, out: [], err: [] }),
      })
      expect(r.outcomes[0]!.status).toBe('cache-hit')
      expect(r.outcomes[0]!.verify).toEqual({ kind: 'not-verified' })
    },
    TIMEOUT,
  )

  it(
    '--verify=all reports undeclared-inputs (short-circuits determinism) for a leaky task',
    async () => {
      const dir = await addProject(
        fixture.root,
        'a',
        inputProject(
          'const fs=require("fs");try{fs.readFileSync("secret.txt")}catch(e){}fs.writeFileSync("out.txt","ok")',
        ),
      )
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'src', 'in.txt'), 'x')
      await writeFile(path.join(dir, 'secret.txt'), 'SECRET')
      const r = await run({
        cwd: fixture.root,
        tasks: ['run'],
        projects: ['a'],
        verify: { determinism: true, inputs: true, fingerprint: true, allow: new Set<string>() },
        log: capturingLogger(fixture),
      })
      expect(r.ok).toBe(false)
      expect(r.outcomes[0]!.verify?.kind).toBe('undeclared-inputs')
    },
    TIMEOUT,
  )
})
