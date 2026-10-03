// A secret-named variable's value never reaches the terminal, the cached
// stdout a hit replays, a telemetry record or `vx show` (L-11). A task
// that echoed `$API_TOKEN`, or a config that built its command from
// `process.env`, put the value in all four.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { run } from '../src/orchestrator/index.js'
import { defaultLogger } from '../src/orchestrator/logger.js'
import { MASKED, maskedEmitter, secretMask } from '../src/util/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

const SECRET = 'hunter2-l11-sekret'
const DEFINED = 'defined-l11-sekret'

describe('secretMask', () => {
  it('holds back only a tail that could begin a value; other output passes at once', () => {
    const s = secretMask([{ API_TOKEN: SECRET }])!.stream()
    // A persistent task's `readyWhen` and a test's start marker read the
    // chunk as it comes: nothing of it may wait for the next one.
    expect(s.push('server ready\n')).toBe('server ready\n')
    expect(s.push('tail hun')).toBe('tail ')
    expect(s.push('gry\n')).toBe('hungry\n')
    expect(s.end()).toBe('')
  })

  it('a held tail is emitted once no chunk follows it', async () => {
    const got: string[] = []
    const e = maskedEmitter(secretMask([{ API_TOKEN: SECRET }])!, (t) => void got.push(t), 20)
    e.push('progress hun')
    expect(got.join('')).toBe('progress ')
    // The shortest wait that shows it: well past the idle bound.
    await Bun.sleep(80)
    expect(got.join('')).toBe('progress hun')
  })

  it('masks a value split across chunks without emitting its prefix', () => {
    const m = secretMask([{ API_TOKEN: SECRET }])!
    const s = m.stream()
    const out = [s.push('before hunter2-'), s.push('l11-sekret after'), s.end()]
    expect(out.join('')).toBe(`before ${MASKED} after`)
    for (const piece of out) expect(piece).not.toContain('hunter2')
  })

  it('names by the words they hold; a short or a plain one is left', () => {
    const m = secretMask([
      {
        NPM_TOKEN: 'aaaaaaaa',
        DB_PASSWORD: 'bbbbbbbb',
        SIGNING_KEY: 'cccccccc',
        MY_SECRET: 'dddddddd',
        API_TOKEN: 'short',
        HOME: 'eeeeeeee',
      },
    ])!
    expect(m.mask('aaaaaaaa bbbbbbbb cccccccc dddddddd short eeeeeeee')).toBe(
      `${MASKED} ${MASKED} ${MASKED} ${MASKED} short eeeeeeee`,
    )
    // CONTROL: nothing secret-named, no mask at all; nor a name that says
    // where a secret lives, nor git's config-key channel.
    expect(secretMask([{ HOME: '/home/x', PATH: '/bin' }])).toBeNull()
    expect(
      secretMask([{ NPM_TOKEN_FILE: '/run/secrets/npm', GIT_CONFIG_KEY_0: 'safe.directory' }]),
    ).toBeNull()
  })
})

describe('a secret-named value in what vx prints, stores and exports', () => {
  let root: string
  const saved = process.env['API_TOKEN']
  beforeEach(async () => {
    process.env['API_TOKEN'] = SECRET
    root = await makeWorkspace({ prefix: 'vx-l11-' })
    await writeLocalWorkspace(root)
    await addProject(root, 'p', {
      files: { 'in.txt': 'x' },
      config: `
        export default {
          tasks: {
            t: {
              exec: {
                command: 'echo "${SECRET} $API_TOKEN $DB_TOKEN" && echo "${SECRET}" >&2 && echo built > out.txt',
                env: { passThrough: ['API_TOKEN'], define: { DB_TOKEN: '${DEFINED}' } },
              },
              cache: { inputs: { files: ['in.txt'] }, outputs: { files: ['out.txt'] } },
            },
          },
        }
      `,
    })
  })
  afterEach(async () => {
    if (saved === undefined) delete process.env['API_TOKEN']
    else process.env['API_TOKEN'] = saved
    await rm(root, { recursive: true, force: true })
  })

  const once = async () => {
    const chunks: string[] = []
    const records: unknown[] = []
    const out = { write: (c: string) => (chunks.push(c), true) }
    const r = await run({
      cwd: root,
      tasks: ['t'],
      log: defaultLogger({ enabled: false }, { mode: 'focused' }, out),
      handleSignals: false,
      telemetrySinks: [{ onRecord: (rec) => void records.push(rec) }],
    })
    return { ok: r.ok, text: chunks.join(''), telemetry: JSON.stringify(records) }
  }

  it("a server's output is masked too", async () => {
    await addProject(root, 'srv', {
      config: `
        export default {
          tasks: {
            dev: {
              exec: {
                command: 'echo "leak $API_TOKEN"; echo ready; exec sleep 30',
                env: { passThrough: ['API_TOKEN'] },
                persistent: { readyWhen: 'ready' },
              },
            },
          },
        }
      `,
    })
    const chunks: string[] = []
    const r = await run({
      cwd: root,
      tasks: ['dev'],
      projects: ['srv'],
      log: defaultLogger(
        { enabled: false },
        { mode: 'focused' },
        {
          write: (c: string) => (chunks.push(c), true),
        },
      ),
      handleSignals: false,
    })
    const text = chunks.join('')
    expect({
      ok: r.ok,
      leaked: text.includes(SECRET),
      masked: text.includes(`leak ${MASKED}`),
    }).toEqual({
      ok: true,
      leaked: false,
      masked: true,
    })
  })

  it('never shows the value; the miss and the replaying hit print the mask', async () => {
    const miss = await once()
    const hit = await once()
    const show = Bun.spawnSync(
      [process.execPath, path.resolve(import.meta.dir, '../src/bin.ts'), 'show', 'p#t'],
      { cwd: root, env: { ...process.env, NO_COLOR: '1' } },
    )
    const json = Bun.spawnSync(
      [
        process.execPath,
        path.resolve(import.meta.dir, '../src/bin.ts'),
        'show',
        'p#t',
        '--format',
        'json',
      ],
      { cwd: root, env: { ...process.env, NO_COLOR: '1' } },
    )
    // The entry's command: `vx why` prints it, a remote cache receives it.
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
    const stored = db
      .query<{ command: string }, []>('SELECT command FROM entries')
      .all()
      .map((r) => r.command)
      .join('\n')
    db.close()
    const all = [
      stored,
      miss.text,
      miss.telemetry,
      hit.text,
      show.stdout.toString(),
      json.stdout.toString(),
    ]
    expect({
      ok: [miss.ok, hit.ok],
      leaked: all.filter((t) => t.includes(SECRET) || t.includes(DEFINED)).length,
      masked: all.map((t) => t.includes(MASKED)),
    }).toEqual({ ok: [true, true], leaked: 0, masked: [true, true, true, true, true, true] })
  })
})

describe('`exec.env.secret` masks a value whatever its name', () => {
  // The name rule misses `GH_PAT`, `NPM_AUTH`: a token so named, echoed by
  // a task, was stored in the entry's stdout and replayed by every hit,
  // local and remote. A variable the task lists in `env.secret` is masked
  // wherever the name rule masks one.
  const PAT = 'ghp-l14-sekret-value'
  let root: string
  const saved = process.env['GH_PAT']
  beforeEach(async () => {
    process.env['GH_PAT'] = PAT
    root = await makeWorkspace({ prefix: 'vx-l14-' })
    await writeLocalWorkspace(root)
  })
  afterEach(async () => {
    if (saved === undefined) delete process.env['GH_PAT']
    else process.env['GH_PAT'] = saved
    await rm(root, { recursive: true, force: true })
  })

  const seen = async (secret: boolean) => {
    await addProject(root, 'p', {
      files: { 'in.txt': 'x' },
      config: `
        export default {
          tasks: {
            t: {
              exec: {
                command: 'echo "pat=$GH_PAT"',
                env: { passThrough: ['GH_PAT']${secret ? ", secret: ['GH_PAT']" : ''} },
              },
              cache: { inputs: { files: ['in.txt'] }, outputs: { files: [] } },
            },
          },
        }
      `,
    })
    const texts: string[] = []
    for (let i = 0; i < 2; i++) {
      const chunks: string[] = []
      const r = await run({
        cwd: root,
        tasks: ['t'],
        log: defaultLogger(
          { enabled: false },
          { mode: 'focused' },
          { write: (c: string) => (chunks.push(c), true) },
        ),
        handleSignals: false,
      })
      expect(r.ok).toBe(true)
      texts.push(chunks.join(''))
    }
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
    const stored = db
      .query<{ stdout: string }, []>('SELECT stdout FROM entry_stdout')
      .all()
      .map((r) => r.stdout)
      .join('\n')
    db.close()
    return [texts[0]!, texts[1]!, stored].map((t) =>
      t.includes(PAT) ? 'value' : t.includes(`pat=${MASKED}`) ? 'masked' : 'absent',
    )
  }

  it('the miss, the stored stdout and the replaying hit print the mask', async () => {
    expect(await seen(true)).toEqual(['masked', 'masked', 'masked'])
  })

  it('CONTROL: undeclared, the name rule does not reach it', async () => {
    expect(await seen(false)).toEqual(['value', 'value', 'value'])
  })
})
