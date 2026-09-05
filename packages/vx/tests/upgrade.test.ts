// vx upgrade — self-update mechanics. The downloader is tested
// against a local server; the CLI path pins the source-mode refusal
// (the compiled-binary path needs a real release and stays manual).

import { readFile, rm, stat } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { isBunfsPath, replaceBinary } from '../src/cli/upgrade.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-upgrade-'))

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('isBunfsPath', () => {
  it('matches the bunfs virtual-root markers (posix + windows)', () => {
    expect(isBunfsPath('/$bunfs/root/vx')).toBe(true)
    expect(isBunfsPath('B:\\~BUN\\root\\vx')).toBe(true)
    expect(isBunfsPath('B:/~BUN/root/vx')).toBe(true)
  })

  it('rejects real source paths — the source-mode signal', () => {
    // Under `--minify --bytecode`, import.meta.path is the SOURCE path;
    // keying compiled-binary detection off it (the old bug) misread
    // every curl-installed binary as "running from source".
    expect(isBunfsPath('/Users/me/vx/src/bin.ts')).toBe(false)
    expect(isBunfsPath('/private/tmp/probe.ts')).toBe(false)
    expect(isBunfsPath('')).toBe(false)
  })
})

describe('replaceBinary', () => {
  // The downloader is driven through a stubbed global `fetch`, not a
  // localhost server. `replaceBinary` takes a URL and calls `fetch`, so
  // the response IS the whole input — binding a port would only add a
  // socket this suite has no reason to open, and a task in this repo has
  // no reason to serve the network.
  const withFetch = async (impl: typeof fetch, body: () => Promise<void>): Promise<void> => {
    const real = globalThis.fetch
    globalThis.fetch = impl
    try {
      await body()
    } finally {
      globalThis.fetch = real
    }
  }

  it('downloads and atomically replaces the destination, executable', async () => {
    const seen: string[] = []
    await withFetch(
      ((input: string | URL | Request) => {
        seen.push(input instanceof Request ? input.url : String(input))
        return Promise.resolve(new Response('#!/bin/sh\necho fake-vx\n'))
      }) as unknown as typeof fetch,
      async () => {
        const dest = path.join(dir, 'vx')
        await Bun.write(dest, 'old')
        await replaceBinary(dest, 'https://example.invalid/asset')
        expect(seen).toEqual(['https://example.invalid/asset'])
        expect(await readFile(dest, 'utf8')).toContain('fake-vx')
        expect((await stat(dest)).mode & 0o111).not.toBe(0)
      },
    )
  })

  it('404 leaves the destination untouched', async () => {
    await withFetch(
      (() => Promise.resolve(new Response('nope', { status: 404 }))) as unknown as typeof fetch,
      async () => {
        const dest = path.join(dir, 'vx2')
        await Bun.write(dest, 'old')
        await expect(replaceBinary(dest, 'https://example.invalid/asset')).rejects.toThrow(
          /download failed \(404\)/,
        )
        expect(await readFile(dest, 'utf8')).toBe('old')
      },
    )
  })
})

describe('vx upgrade (CLI)', () => {
  it('refuses when running from source', async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, path.join(import.meta.dir, '..', 'src', 'bin.ts'), 'upgrade'],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const code = await proc.exited
    const err = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(err).toContain('only works for the compiled binary')
  })
})
