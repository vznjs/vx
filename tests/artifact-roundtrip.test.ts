// Artifact round-trip integrity. Nothing else in the suite drives a REAL
// build through a real cache hit and asserts the restored tree is identical
// to what the task produced — names, bytes AND modes. That gap is exactly why
// two silent-data-loss defects survived: outputs whose archive entry name
// exceeded 100 bytes were dropped on every restore, and the executable bit was
// stripped from every cached output.
//
// These are end-to-end on purpose. A unit test on the tar reader can pass
// while `packArtifact` still stages the wrong mode, and vice versa — only the
// full produce → cache → wipe → restore loop pins the property that matters.

import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Cache } from '../src/cache/cache.js'

const TIMEOUT = 60_000
const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')

async function write(p: string, content: string): Promise<void> {
  await mkdir(path.dirname(p), { recursive: true })
  await writeFile(p, content)
}

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync({
    cmd: ['git', '-c', 'commit.gpgsign=false', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (p.exitCode !== 0) {
    const detail = [
      new TextDecoder().decode(p.stderr).trim(),
      new TextDecoder().decode(p.stdout).trim(),
    ]
      .filter((s) => s.length > 0)
      .join(' | ')
    throw new Error(`git ${args.join(' ')} exited ${p.exitCode}: ${detail}`)
  }
}

function vx(cwd: string, ...args: string[]): { out: string; exitCode: number } {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  return {
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
    exitCode: p.exitCode ?? -1,
  }
}

/** Every file under `dir`, as rel → { bytes, mode }. The full restore contract. */
async function snapshotTree(dir: string): Promise<Map<string, { text: string; mode: number }>> {
  const out = new Map<string, { text: string; mode: number }>()
  const walk = async (cur: string): Promise<void> => {
    for (const e of await readdir(cur, { withFileTypes: true })) {
      const abs = path.join(cur, e.name)
      if (e.isDirectory()) {
        await walk(abs)
      } else {
        const st = await stat(abs)
        out.set(path.relative(dir, abs).split(path.sep).join('/'), {
          text: await Bun.file(abs).text(),
          mode: st.mode & 0o777,
        })
      }
    }
  }
  await walk(dir)
  return out
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-artifact-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('artifact round-trip', () => {
  it(
    'a cache hit restores the produced tree byte- and mode-identically',
    async () => {
      // The generator writes the shapes a real build produces and a naive
      // artifact pipeline mangles:
      //   - a DEEP path whose archive entry name exceeds 100 bytes (ustar
      //     splits it into prefix+name; a reader that ignores `prefix` loses
      //     the `outputs/` namespace and drops the file entirely)
      //   - a single FILENAME over 100 bytes (ustar cannot split it at all)
      //   - an EXECUTABLE (0755) — a CLI shim / compiled binary / generated
      //     script, all routine
      //   - ordinary nested files, as the control
      const deepDir = 'dist/packages/design-system-components/esm/react/primitives/button'
      const longName = `${'x'.repeat(120)}.js`
      await write(
        path.join(root, 'package.json'),
        '{"name":"@acme/app","version":"1.0.0","private":true}',
      )
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             build: {
               exec: {
                 command: [
                   'mkdir -p ${deepDir}',
                   'cp src/in.txt dist/plain.js',
                   'cp src/in.txt ${deepDir}/index.esm.production.min.js',
                   'cp src/in.txt dist/${longName}',
                   'printf "#!/bin/sh\\\\necho hi\\\\n" > dist/cli',
                   'chmod 755 dist/cli',
                 ].join(' && '),
               },
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'src/in.txt'), 'PRODUCED-CONTENT')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'init')

      // Cold run: the task actually executes. A pack format that cannot
      // express one of these names fails HERE, turning a working build into a
      // failed run.
      const cold = vx(root, 'run', 'build')
      expect(cold.exitCode).toBe(0)

      const produced = await snapshotTree(path.join(root, 'dist'))
      // Guard the fixture itself before trusting the comparison.
      expect(produced.has(`${deepDir.slice('dist/'.length)}/index.esm.production.min.js`)).toBe(
        true,
      )
      expect(produced.has(longName)).toBe(true)
      expect(produced.get('cli')?.mode).toBe(0o755)
      // The archive entry name is `outputs/` + the path relative to the
      // PROJECT dir — this is the >100-byte threshold that trips the split.
      expect(Buffer.byteLength(`outputs/${deepDir}/index.esm.production.min.js`)).toBeGreaterThan(
        100,
      )

      // Wipe and replay from cache.
      await rm(path.join(root, 'dist'), { recursive: true, force: true })
      const warm = vx(root, 'run', 'build')
      expect(warm.exitCode).toBe(0)

      const restored = await snapshotTree(path.join(root, 'dist'))
      // Full equality: no missing entry, no extra entry, same bytes, same mode.
      expect([...restored.keys()].sort()).toEqual([...produced.keys()].sort())
      for (const [rel, want] of produced) {
        expect(restored.get(rel)).toEqual(want)
      }
    },
    TIMEOUT,
  )

  it(
    'an output filename longer than 100 bytes does not fail the run',
    async () => {
      // ustar refuses a name it cannot split ("file name is too long (cannot
      // be split)", exit 2) — and `packArtifact` runs AFTER the task already
      // succeeded, so the failure was reported as a failed build.
      await write(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await write(
        path.join(root, 'vx.config.mjs'),
        `export default {
           tasks: {
             snap: {
               exec: { command: 'mkdir -p out && cp src/in.txt out/${'y'.repeat(140)}.snap' },
               cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out/**'] } },
             },
           },
         }`,
      )
      await write(path.join(root, 'src/in.txt'), 'SNAPSHOT')
      git(root, 'init', '-q')
      git(root, 'config', 'user.email', 'test@vx.local')
      git(root, 'config', 'user.name', 'vx test')
      git(root, 'add', '-A')
      git(root, 'commit', '-qm', 'init')

      const res = vx(root, 'run', 'snap')
      expect(res.out).not.toContain('file name is too long')
      expect(res.exitCode).toBe(0)
    },
    TIMEOUT,
  )
})

describe('restoreOutputs refuses to report a hit it cannot materialize', () => {
  let cacheDir: string
  let projectDir: string
  let cache: Cache

  beforeEach(async () => {
    cacheDir = path.join(root, 'cache')
    projectDir = path.join(root, 'proj')
    await mkdir(projectDir, { recursive: true })
    cache = new Cache(cacheDir)
  })

  afterEach(() => {
    cache.close()
  })

  async function saveEntry(hash: string): Promise<void> {
    await write(path.join(projectDir, 'dist/app.js'), 'BUILT')
    await chmod(path.join(projectDir, 'dist/app.js'), 0o755)
    await cache.save({
      hash,
      entry: { taskId: 'a#build', command: 'build', durationMs: 1, stdout: '' },
      projectDir,
      outputFiles: [path.join(projectDir, 'dist/app.js')],
    })
  }

  it('throws when the artifact vanished between the probe and the restore', async () => {
    await saveEntry('gone')
    // A concurrent `vx cache prune` is the documented way this happens. The
    // caller has ALREADY wiped the declared outputs by now, so returning
    // quietly would report a green hit over an emptied tree.
    await rm(cache.outputsPath('gone'), { force: true })
    await rm(path.join(projectDir, 'dist'), { recursive: true, force: true })

    await expect(cache.restoreOutputs('gone', projectDir)).rejects.toThrow(/corrupt artifact/i)
  })

  it('throws when the artifact cannot produce an output the index recorded', async () => {
    await saveEntry('hollow')
    // Replace the stored bytes with a structurally VALID artifact that simply
    // has no outputs — the index still lists dist/app.js, so restoring
    // "successfully" would leave a hole nothing detects afterwards.
    const stage = await mkdtemp(path.join(os.tmpdir(), 'vx-hollow-'))
    await writeFile(path.join(stage, 'stdout'), '')
    const proc = Bun.spawn(['tar', '--format=gnu', '-cf', '-', '-C', stage, 'stdout'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const tarBytes = await new Response(proc.stdout).bytes()
    await proc.exited
    await Bun.write(cache.outputsPath('hollow'), await Bun.zstdCompress(tarBytes))
    await rm(stage, { recursive: true, force: true })

    await expect(cache.restoreOutputs('hollow', projectDir)).rejects.toThrow(
      /missing 1 recorded output/i,
    )
  })

  it('restores normally when the artifact is intact (control)', async () => {
    await saveEntry('ok')
    await rm(path.join(projectDir, 'dist'), { recursive: true, force: true })
    await cache.restoreOutputs('ok', projectDir)
    expect(await Bun.file(path.join(projectDir, 'dist/app.js')).text()).toBe('BUILT')
    expect((await stat(path.join(projectDir, 'dist/app.js'))).mode & 0o777).toBe(0o755)
  })
})
