// `outputs.mount`: a task's outputs hold a tree its programs expect at
// a fixed absolute path (Nix's `/nix/store`), and each sandboxed task that
// depends on it sees that tree mounted there, read-only. vx caches and
// restores the tree like any output; only the dependant's view moves it.
// Linux only: seatbelt does not mount.
import { mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject } from './helpers/workspace.js'
import { run } from './helpers/orchestrator.js'
import {
  TIMEOUT,
  type Fixture,
  collectingLogger,
  makeWorkspace,
} from './helpers/sandbox-fixture.js'

const available = process.platform === 'linux' && (await sandboxAvailable('dependency mount test'))

/**
 * A tools task whose program lives in `out/store/<entry>` and reads its
 * data by the absolute path the mount gives it, as a Nix binary names
 * `/nix/store/...`. `out/bin/<prog>` links there absolutely.
 */
const tool = (target: string, entry: string, prog: string, word: string): string => {
  const at = `${target}/${entry}`
  const cmd = [
    `mkdir -p out/store/${entry}/bin out/bin`,
    `printf '#!/bin/sh\\nread w < ${at}/data.txt && echo "$w"\\n' > out/store/${entry}/bin/${prog}`,
    `chmod +x out/store/${entry}/bin/${prog}`,
    `echo ${word} > out/store/${entry}/data.txt`,
    `ln -s ${at}/bin/${prog} out/bin/${prog}`,
  ].join(' && ')
  return `
    export default {
      tasks: {
        build: {
          exec: { command: ${JSON.stringify(cmd)}, platforms: ['linux-x64', 'linux-arm64'] },
          inputs: { files: ['src/**'] },
          outputs: { files: ['out/**'], bin: 'out/bin', mount: { ${JSON.stringify(target)}: 'out/store' } },
          cache: true,
        },
      },
    }
  `
}

describe.skipIf(!available)('a dependency’s declared mount is where its dependants see it', () => {
  let fixture: Fixture
  let target: string

  beforeEach(async () => {
    fixture = await makeWorkspace()
    // An empty directory outside the workspace, as `/nix/store` is on a
    // machine that never ran Nix: the mount fills it for the task only.
    target = await mkdtemp(path.join(os.tmpdir(), 'vx-mount-target-'))
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
    await rm(target, { recursive: true, force: true })
  })

  const use = async (dependsOn: string[], sandbox = '{}', command = 'hello') => {
    await addProject(fixture.root, 'app', {
      files: { 'src/a.txt': 'A\n' },
      config: `
        export default {
          tasks: {
            use: {
              exec: { command: ${JSON.stringify(command)}${sandbox === '' ? '' : `, sandbox: ${sandbox}`} },
              dependsOn: ${JSON.stringify(dependsOn)},
            },
          },
        }
      `,
    })
    const r = await run({ cwd: fixture.root, tasks: ['use'], log: collectingLogger(fixture) })
    return { ok: r.ok, log: fixture.log.join('\n') }
  }

  it(
    'a sandboxed dependant runs the program through the mount',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool(target, 'e1-node', 'hello', 'NODE'),
      })
      const r = await use(['node#build'])
      expect(r.log).toContain('NODE')
      expect(r.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'the mount is the dependant’s alone: the host path stays empty',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool(target, 'e1-node', 'hello', 'NODE'),
      })
      const r = await use(['node#build'], '{}', `read w < ${target}/e1-node/data.txt && echo "$w"`)
      expect(r.log).toContain('NODE')
      // The mount is the dependant's alone: nothing landed on the host.
      expect(
        await Array.fromAsync(new Bun.Glob('*').scan({ cwd: target, onlyFiles: false })),
      ).toEqual([])
    },
    TIMEOUT,
  )

  it(
    'a hermetic dependant sees it too',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool(target, 'e1-node', 'hello', 'NODE'),
      })
      const r = await use(['node#build'], `{ hermetic: true, allow: { read: ['.'] } }`)
      expect(r.log).toContain('NODE')
      expect(r.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'two dependencies mounting one path are both there, entry by entry',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool(target, 'e1-node', 'hello', 'NODE'),
      })
      await addProject(fixture.root, 'bun', {
        files: { 'src/s.txt': 's\n' },
        config: tool(target, 'e2-bun', 'hi', 'BUN'),
      })
      const r = await use(['node#build', 'bun#build'], '{}', 'hello && hi')
      expect(r.log).toContain('NODE')
      expect(r.log).toContain('BUN')
      expect(r.ok).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'an unsandboxed dependant is refused, naming the mount',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool(target, 'e1-node', 'hello', 'NODE'),
      })
      const r = await use(['node#build'], '')
      expect(r.ok).toBe(false)
      expect(r.log).not.toContain('NODE')
      expect(r.log).toContain('outputs.mount')
      expect(r.log).toContain('exec.sandbox')
    },
    TIMEOUT,
  )

  it(
    'a mount path missing on this machine is refused, saying to create it',
    async () => {
      await rm(target, { recursive: true, force: true })
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool(target, 'e1-node', 'hello', 'NODE'),
      })
      const r = await use(['node#build'])
      expect(r.ok).toBe(false)
      expect(r.log).toContain(target)
      expect(r.log).toContain('mkdir -p')
      await mkdir(target)
    },
    TIMEOUT,
  )

  it(
    'a hit restores the tree, its links into the mount kept as written',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: tool(target, 'e1-node', 'hello', 'NODE'),
      })
      expect((await use(['node#build'])).ok).toBe(true)
      const out = path.join(fixture.root, 'packages/node/out')
      await rm(out, { recursive: true, force: true })
      await writeFile(path.join(fixture.root, 'packages/app/src/a.txt'), 'B\n')
      fixture.log.length = 0
      const r = await use(['node#build'])
      expect(r.ok).toBe(true)
      expect(r.log).toContain('NODE')
      expect(await readlink(path.join(out, 'bin/hello'))).toBe(`${target}/e1-node/bin/hello`)
    },
    TIMEOUT,
  )
})

describe.skipIf(!available)('a link out of a mount is still refused', () => {
  let fixture: Fixture
  beforeEach(async () => {
    fixture = await makeWorkspace()
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  it(
    'an absolute link outside every declared mount fails the save',
    async () => {
      await addProject(fixture.root, 'node', {
        files: { 'src/s.txt': 's\n' },
        config: `
          export default {
            tasks: {
              build: {
                exec: {
                  command: 'mkdir -p out/store && ln -s /etc/hostname out/store/h',
                  platforms: ['linux-x64', 'linux-arm64'],
                },
                inputs: { files: ['src/**'] },
                outputs: { files: ['out/**'], mount: { '/nix/store': 'out/store' } },
                cache: true,
              },
            },
          }
        `,
      })
      const r = await run({ cwd: fixture.root, tasks: ['build'], log: collectingLogger(fixture) })
      expect(r.ok).toBe(true)
      expect(fixture.log.join('\n')).toContain('symlink to an absolute path (/etc/hostname)')
    },
    TIMEOUT,
  )
})
