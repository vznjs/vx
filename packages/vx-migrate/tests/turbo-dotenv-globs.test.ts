// Turbo hashes the `.env` files its root-relative globs name. The mapper
// probed every `.env`-shaped file in the tree instead, so on trigger.dev
// (`apps/*/.env`, `.env.*`) an edit to `hosting/docker/.env.example`
// re-keyed every task and Turbo's none. Turbo's `*` matches a hidden name
// (probed on 2.11.6: `apps/.h/.env`, `.x.env`); the shell's does not.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { planRun } from '@vzn/vx'
import { dotenvGlobsProbe } from '../src/dotenv-probe.js'
import { silent, useTurboWorkspace } from './helpers/turbo-workspace.js'

const ws = useTurboWorkspace({
  globalDependencies: ['.env.*', 'packages/*/.env', '*.env'],
  tasks: { build: { outputs: ['dist/**'] } },
})

describe('turbo(): root `.env` globs', () => {
  it('key the files they name, hidden ones too, and no other', async () => {
    const root = ws.root
    await writeFile(path.join(root, '.gitignore'), 'dist\n.env*\n*.env\n')
    await mkdir(path.join(root, 'hosting'), { recursive: true })
    await mkdir(path.join(root, 'packages', '.h'), { recursive: true })
    const key = async () => {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      return plan.tasks.find((t) => t.node.id === 'lib#build')!.hash
    }
    const moved = async (rel: string): Promise<boolean> => {
      const before = await key()
      await writeFile(path.join(root, rel), `${rel}\n`)
      return (await key()) !== before
    }
    expect({
      other: await moved('hosting/.env.example'),
      nested: await moved('packages/lib/src/.env'),
      root: await moved('.env.local'),
      pkg: await moved('packages/lib/.env'),
      hiddenDir: await moved('packages/.h/.env'),
      hiddenName: await moved('.x.env'),
    }).toEqual({
      other: false,
      nested: false,
      root: true,
      pkg: true,
      hiddenDir: true,
      hiddenName: true,
    })
  }, 30_000)
})

describe('turbo(): a `**` root `.env` glob', () => {
  it("keys what create-turbo's `**/.env.*local` names, and not a `.env.example`", async () => {
    const root = ws.root
    await writeFile(
      path.join(root, 'turbo.json'),
      JSON.stringify({ globalDependencies: ['**/.env.*local'], tasks: { build: {} } }),
    )
    await writeFile(path.join(root, '.gitignore'), 'dist\n.env*.local\nnode_modules\n')
    await writeFile(path.join(root, 'packages', 'app', '.env.example'), 'A=1\n')
    await mkdir(path.join(root, 'packages', 'app', 'node_modules', 'x'), { recursive: true })
    Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
    const key = async () => {
      const plan = await planRun({ cwd: root, tasks: ['build'], log: silent() })
      return plan.tasks.find((t) => t.node.id === 'lib#build')!.hash
    }
    const moved = async (rel: string): Promise<boolean> => {
      const before = await key()
      await writeFile(path.join(root, rel), `${rel}\n`)
      return (await key()) !== before
    }
    expect({
      example: await moved('packages/app/.env.example'),
      dependency: await moved('packages/app/node_modules/x/.env.local'),
      local: await moved('packages/app/.env.local'),
      root: await moved('.env.production.local'),
    }).toEqual({ example: false, dependency: false, local: true, root: true })
  }, 30_000)
})

describe('dotenvGlobsProbe', () => {
  it('spells a leading `*` for hidden names, finds a `**` name, and gives up on the rest', () => {
    expect({
      word: dotenvGlobsProbe(['apps/*/.env', '*.env', '.env', '**/.env.*local', 'x/**/.env']),
      mid: dotenvGlobsProbe(['a/**/b/.env']),
      starDir: dotenvGlobsProbe(['a*/**/.env']),
      brace: dotenvGlobsProbe(['.env.{a,b}']),
      quote: dotenvGlobsProbe(["it's/.env"]),
      climb: dotenvGlobsProbe(['../.env']),
    }).toEqual({
      word:
        'LC_ALL=C; export LC_ALL; { for f in apps/*/.env apps/.[!.]*/.env apps/..?*/.env *.env .*.env .env; ' +
        `do [ -f "$f" ] && printf '%s\\n' "$f"; done; ` +
        "find . \\( -name node_modules -o -name .git \\) -prune -o -type f -name '.env.*local' -print 2>/dev/null | sed 's|^\\./||'; " +
        "find x \\( -name node_modules -o -name .git \\) -prune -o -type f -name '.env' -print 2>/dev/null | sed 's|^\\./||'; } " +
        `| sort -u | while IFS= read -r f; do printf '%s\\n' "$f"; cat -- "$f"; echo .; done`,
      mid: null,
      starDir: null,
      brace: null,
      quote: null,
      climb: null,
    })
  })
})
