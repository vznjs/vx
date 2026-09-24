// Nx's per-task `.env` files: which ones, in which order (the mapper's
// half, `src/nx/nx-dotenv.ts`), and the `nx-env` bin that loads them for a
// shell line, against the FAKE `nx` (`helpers/fake-nx.ts`). Real Nx's
// parsing and precedence are `nx-exec-live.test.ts`.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  dotenvCandidates,
  existingDotenv,
  listDotenv,
  nonAtomizedTargetOf,
} from '../src/nx/nx-dotenv.js'
import { fakeNx } from './helpers/fake-nx.js'

const NX_ENV = path.resolve(import.meta.dir, '..', 'src', 'nx-env.cjs')

describe('dotenvCandidates — Nx’s getEnvPathsForTask', () => {
  it('the project’s files before the root’s, the most specific name first', () => {
    const variants = (p: string, id: string) => [
      `${p}.env.${id}.local`,
      `${p}.env.${id}`,
      `${p}.${id}.local.env`,
      `${p}.${id}.env`,
    ]
    const plain = (p: string) => [`${p}.env.local`, `${p}.local.env`, `${p}.env`]
    expect(dotenvCandidates('apps/web', 'build', undefined, undefined)).toEqual([
      ...variants('apps/web/', 'build'),
      ...plain('apps/web/'),
      ...variants('', 'build'),
      ...plain(''),
    ])
    expect(dotenvCandidates('apps/web', 'e2e-ci--a', 'ci', 'e2e-ci')).toEqual([
      ...['e2e-ci--a.ci', 'e2e-ci.ci', 'ci', 'e2e-ci--a', 'e2e-ci'].flatMap((id) =>
        variants('apps/web/', id),
      ),
      ...plain('apps/web/'),
      ...['e2e-ci--a.ci', 'e2e-ci.ci', 'ci', 'e2e-ci--a', 'e2e-ci'].flatMap((id) =>
        variants('', id),
      ),
      ...plain(''),
    ])
  })

  it('an atomized target’s parent comes from the project’s targetGroups', () => {
    const targets = {
      'e2e-ci': {},
      'e2e-ci--a': { metadata: { nonAtomizedTarget: 'e2e-ci' } },
    }
    const groups = { E2E: ['e2e-ci--a', 'e2e-ci'] }
    expect(nonAtomizedTargetOf('e2e-ci--a', targets, groups)).toBe('e2e-ci')
    expect(nonAtomizedTargetOf('build', targets, groups)).toBeUndefined()
    expect(nonAtomizedTargetOf('e2e-ci--a', targets, undefined)).toBeUndefined()
  })

  it('keeps the ones a listing of each directory holds, in order', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vx-nx-dotenv-'))
    try {
      await mkdir(path.join(root, 'apps', 'web'), { recursive: true })
      for (const f of [
        '.env',
        '.env.local',
        'apps/web/.env.build',
        'apps/web/.env',
        'apps/web/src.ts',
      ])
        await writeFile(path.join(root, f), '')
      const listing = await listDotenv(root, ['apps/web', 'apps/missing'])
      expect(
        existingDotenv(dotenvCandidates('apps/web', 'build', undefined, undefined), listing),
      ).toEqual(['apps/web/.env.build', 'apps/web/.env', '.env.local', '.env'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('nx-env', () => {
  let root: string
  let cwd: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'vx-nx-env-'))
    cwd = path.join(root, 'packages', 'app')
    await mkdir(cwd, { recursive: true })
    await writeFile(path.join(root, 'package.json'), '{"name":"ws","private":true}')
    await fakeNx(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function nxEnv(args: string[], env: Record<string, string> = {}) {
    const p = Bun.spawn(['node', NX_ENV, ...args], {
      cwd,
      env: { PATH: process.env['PATH']!, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
    })
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ])
    return { code, out, err }
  }

  it('loads the files in order, the environment winning, then envFile under them; appends the arguments as vx does', async () => {
    await writeFile(path.join(cwd, '.env.build'), 'A=build\n')
    await writeFile(path.join(cwd, '.env'), 'A=project\nB=project\n')
    await writeFile(path.join(root, '.env'), 'B=root\nC=root\nD=root\n')
    await writeFile(path.join(root, '.env.custom'), 'D=custom\nE=custom\n')
    const r = await nxEnv(
      [
        '--dotenv',
        '.env.build',
        '--dotenv',
        '.env',
        '--dotenv',
        '../../.env',
        '--envFile',
        '../../.env.custom',
        '--',
        'printf "%s|" "$A" "$B" "$C" "$D" "$E" "$F"',
        "it's",
      ],
      { F: 'host', C: 'host' },
    )
    expect({ code: r.code, out: r.out, err: r.err }).toEqual({
      code: 0,
      out: "build|project|host|root|custom|host|it's|",
      err: '',
    })
  })

  it('an envFile it cannot read fails the task, as Nx fails it', async () => {
    const r = await nxEnv(['--envFile', 'nope.env', '--', 'echo ran'])
    expect({ code: r.code, out: r.out, hit: r.err.startsWith('nx-env: ') }).toEqual({
      code: 1,
      out: '',
      hit: true,
    })
  })

  it('the exit is the shell’s, even when the line TERMs its own process group', async () => {
    expect((await nxEnv(['--', 'exit 7'])).code).toBe(7)
    // What a failed parallel run-commands line does: TERM the group, exit 1.
    const r = await nxEnv([
      '--',
      `trap 'trap "" TERM; kill -TERM 0; exit 1' USR1; sleep 5 & kill -USR1 $$; wait`,
    ])
    expect(r.code).toBe(1)
  })

  it('usage errors are exit 2', async () => {
    const r = await nxEnv(['--dotenv'])
    expect({ code: r.code, hit: r.err.includes('usage: nx-env') }).toEqual({ code: 2, hit: true })
  })
})
