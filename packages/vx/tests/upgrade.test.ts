// vx upgrade — self-update mechanics. The downloader is tested
// against a local server; the CLI path pins the source-mode refusal
// (the compiled-binary path needs a real release and stays manual).

import { readFile, rm } from 'node:fs/promises'
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
  it('downloads and atomically replaces the destination, executable', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('#!/bin/sh\necho fake-vx\n'),
    })
    try {
      const dest = path.join(dir, 'vx')
      await Bun.write(dest, 'old')
      await replaceBinary(dest, `http://localhost:${server.port}/asset`)
      expect(await readFile(dest, 'utf8')).toContain('fake-vx')
      const mode = (await import('node:fs/promises')).stat(dest)
      expect(((await mode).mode & 0o111) !== 0).toBe(true)
    } finally {
      await server.stop(true)
    }
  })

  it('404 leaves the destination untouched', async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 404 }) })
    try {
      const dest = path.join(dir, 'vx2')
      await Bun.write(dest, 'old')
      await expect(replaceBinary(dest, `http://localhost:${server.port}/asset`)).rejects.toThrow(
        /download failed \(404\)/,
      )
      expect(await readFile(dest, 'utf8')).toBe('old')
    } finally {
      await server.stop(true)
    }
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
