// vx upgrade — self-update mechanics. The downloader is tested
// against a local server; the CLI path pins the source-mode refusal
// (the compiled-binary path needs a real release and stays manual).

import { readFile, rm, stat } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { isBunfsPath, releaseAsset, replaceBinary } from '../src/cli/upgrade.js'

const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-upgrade-'))
const FAKE = '#!/bin/sh\necho fake-vx\n'
const FAKE_SHA = new Bun.CryptoHasher('sha256').update(FAKE).digest('hex')

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
        return Promise.resolve(new Response(FAKE))
      }) as unknown as typeof fetch,
      async () => {
        const dest = path.join(dir, 'vx')
        await Bun.write(dest, 'old')
        await replaceBinary(dest, 'https://example.invalid/asset', FAKE_SHA)
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
        await expect(
          replaceBinary(dest, 'https://example.invalid/asset', FAKE_SHA),
        ).rejects.toThrow(/download failed \(404\)/)
        expect(await readFile(dest, 'utf8')).toBe('old')
      },
    )
  })

  it('a download that does not match the release digest replaces nothing', async () => {
    // A cut transfer or a swapped asset: the bytes arrive, the digest
    // does not, and the running executable stays what it was. Without
    // the check the rename went through and the next `vx` did not start.
    await withFetch(
      (() => Promise.resolve(new Response(FAKE.slice(0, 10)))) as unknown as typeof fetch,
      async () => {
        const dest = path.join(dir, 'vx3')
        await Bun.write(dest, 'old')
        await expect(
          replaceBinary(dest, 'https://example.invalid/asset', FAKE_SHA),
        ).rejects.toThrow(/did not match the release's SHA-256/)
        expect(await readFile(dest, 'utf8')).toBe('old')
        expect(await Array.fromAsync(new Bun.Glob('vx3.upgrade-*').scan({ cwd: dir }))).toEqual([])
      },
    )
  })
})

describe('releaseAsset', () => {
  const release = {
    tag_name: 'v0.0.21',
    assets: [
      {
        name: 'vx-darwin-arm64',
        browser_download_url: 'https://x/d',
        digest: 'sha256:' + 'a'.repeat(64),
      },
      {
        name: 'vx-linux-x64',
        browser_download_url: 'https://x/l',
        digest: 'sha256:' + 'B'.repeat(64),
      },
      { name: 'vx-linux-arm64', browser_download_url: 'https://x/a' },
    ],
  }

  it('picks the platform asset and its lower-case hex digest', () => {
    expect(releaseAsset(release, 'vx-linux-x64')).toEqual({
      url: 'https://x/l',
      sha256: 'b'.repeat(64),
    })
  })

  it('refuses a release without the asset, and an asset without a digest', () => {
    expect(() => releaseAsset(release, 'vx-windows-x64')).toThrow(
      /v0.0.21 has no asset vx-windows-x64/,
    )
    expect(() => releaseAsset(release, 'vx-linux-arm64')).toThrow(
      /publishes no SHA-256 digest for vx-linux-arm64/,
    )
    expect(() => releaseAsset({ message: 'Not Found' }, 'vx-linux-x64')).toThrow(/has no asset/)
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
