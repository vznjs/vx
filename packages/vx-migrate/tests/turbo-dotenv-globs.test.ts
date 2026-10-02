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

describe('dotenvGlobsProbe', () => {
  it('spells a leading `*` for hidden names, and gives up on what the shell reads otherwise', () => {
    expect({
      word: dotenvGlobsProbe(['apps/*/.env', '*.env', '.env']),
      deep: dotenvGlobsProbe(['**/.env']),
      brace: dotenvGlobsProbe(['.env.{a,b}']),
      quote: dotenvGlobsProbe(["it's/.env"]),
      climb: dotenvGlobsProbe(['../.env']),
    }).toEqual({
      word:
        'LC_ALL=C; export LC_ALL; for f in apps/*/.env apps/.[!.]*/.env apps/..?*/.env *.env .*.env .env; ' +
        `do [ -f "$f" ] && printf '%s\\n' "$f"; done | sort -u | while IFS= read -r f; do printf '%s\\n' "$f"; cat -- "$f"; echo .; done`,
      deep: null,
      brace: null,
      quote: null,
      climb: null,
    })
  })
})
