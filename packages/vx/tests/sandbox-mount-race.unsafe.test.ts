// A mount that went away as bwrap set the sandbox up. On CI a `docker build`
// beside a sandboxed task left a transient mount under /tmp; bwrap read it
// from the mount table, then failed to remount it read-only (`bwrap: Can't
// bind mount /oldroot/ on /newroot/: Unable to apply mount flags: remount
// "/newroot/tmp/containerd-mount…": No such file or directory`), and the
// task failed in 23 ms having never started. Its command never ran, so it
// is run once more. A fake `bwrap` first on PATH plays the race once.
// Caught between the unmount and the removal of its directory, the same
// remount fails `Invalid argument`: the path is no longer a mount point.
//
// A path the wrap walls gone before bwrap mounts on it is the same race:
// bwrap makes the mount point anew under a read-only parent and fails. The
// no-scan directory every wrap walls was removed by a parallel shard's
// test, and a task under the 10-shard load failed with no refusal named.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  initSandbox,
  resetSandbox,
  resolveSandboxConfig,
  runSandboxed,
} from '../src/sandbox/runtime.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox mount race test')
const realBwrap = Bun.which('bwrap')
const RACE =
  'bwrap: Can\'t bind mount /oldroot/ on /newroot/: Unable to apply mount flags: remount "/newroot/tmp/containerd-mount1": No such file or directory'
const UNMOUNTED =
  'bwrap: Can\'t bind mount /oldroot/ on /newroot/: Unable to apply mount flags: remount "/newroot/tmp/containerd-mount1517674899": Invalid argument'
const POINT_GONE = "bwrap: Can't mkdir /tmp/vx-noscan-0: Read-only file system"

describe.skipIf(!available || process.platform !== 'linux' || realBwrap === null)(
  'a sandboxed task whose sandbox lost a mount as it was set up',
  () => {
    let dir = ''
    let prevPath: string | undefined
    beforeEach(async () => {
      dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'vx-mount-race-')))
      const bin = path.join(dir, 'bin')
      await mkdir(bin)
      await writeFile(
        path.join(bin, 'bwrap'),
        [
          '#!/bin/sh',
          // Only the task's own wrap races; probes pass through.
          `case "$*" in *marker-*) ;; *) exec ${realBwrap} "$@";; esac`,
          `n=$(cat ${dir}/races 2>/dev/null); n=\${n:-0}`,
          `if [ "$n" -lt "$(cat ${dir}/times)" ]; then`,
          `  echo $((n+1)) > ${dir}/races`,
          `  cat ${dir}/race >&2`,
          '  exit 1',
          'fi',
          `exec ${realBwrap} "$@"`,
          '',
        ].join('\n'),
      )
      await chmod(path.join(bin, 'bwrap'), 0o755)
      prevPath = process.env['PATH']
      process.env['PATH'] = `${bin}:${prevPath ?? ''}`
      await initSandbox()
    })
    afterEach(async () => {
      process.env['PATH'] = prevPath
      await resetSandbox()
      // The runtime keeps its last config past a reset, and its dependency
      // check reads the bwrap path from it: the next file in this process
      // found the fake's, deleted below, and called the sandbox unavailable.
      await initSandbox()
      await resetSandbox()
      await rm(dir, { recursive: true, force: true })
    })

    const run = async (times: number, race = RACE) => {
      await writeFile(path.join(dir, 'times'), String(times))
      await writeFile(path.join(dir, 'race'), `${race}\n`)
      let streamed = ''
      const r = await runSandboxed({
        command: 'echo marker-ran',
        cwd: dir,
        env: process.env,
        baseAllowRead: [dir],
        baseDenyRead: [],
        reportWithin: dir,
        reportLinked: [],
        config: resolveSandboxConfig({}, dir),
        onStderr: (s) => (streamed += s),
      })
      return {
        exitCode: r.exitCode,
        stdout: r.stdout,
        streamed,
        races: Number((await readFile(path.join(dir, 'races'), 'utf8')).trim()),
      }
    }

    it('is run once more, and the second attempt is its verdict', async () => {
      expect(await run(1)).toEqual({
        exitCode: 0,
        stdout: 'marker-ran\n',
        streamed: `${RACE}\n[vx] a mount went away as the sandbox was set up; running the task again\n`,
        races: 1,
      })
    }, 30_000)

    it('is run once more when the mount is gone but its directory is not', async () => {
      expect(await run(1, UNMOUNTED)).toEqual({
        exitCode: 0,
        stdout: 'marker-ran\n',
        streamed: `${UNMOUNTED}\n[vx] a mount went away as the sandbox was set up; running the task again\n`,
        races: 1,
      })
    }, 30_000)

    it('is run once more when a path it walls went away before its mount', async () => {
      expect(await run(1, POINT_GONE)).toEqual({
        exitCode: 0,
        stdout: 'marker-ran\n',
        streamed: `${POINT_GONE}\n[vx] a mount went away as the sandbox was set up; running the task again\n`,
        races: 1,
      })
    }, 30_000)

    it('is run once more only: a second race is the verdict', async () => {
      const r = await run(2)
      expect([r.exitCode, r.stdout, r.races]).toEqual([1, '', 2])
    }, 30_000)
  },
)
