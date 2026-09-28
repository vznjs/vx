// A secret-named variable's value never reaches the terminal, the cached
// stdout a hit replays, a telemetry record or `vx show` (L-11). A task
// that echoed `$API_TOKEN`, or a config that built its command from
// `process.env`, put the value in all four.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
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
    const s = secretMask({ API_TOKEN: SECRET })!.stream()
    // A persistent task's `readyWhen` and a test's start marker read the
    // chunk as it comes: nothing of it may wait for the next one.
    expect(s.push('server ready\n')).toBe('server ready\n')
    expect(s.push('tail hun')).toBe('tail ')
    expect(s.push('gry\n')).toBe('hungry\n')
    expect(s.end()).toBe('')
  })

  it('a held tail is emitted once no chunk follows it', async () => {
    const got: string[] = []
    const e = maskedEmitter(secretMask({ API_TOKEN: SECRET })!, (t) => void got.push(t), 20)
    e.push('progress hun')
    expect(got.join('')).toBe('progress ')
    // The shortest wait that shows it: well past the idle bound.
    await Bun.sleep(80)
    expect(got.join('')).toBe('progress hun')
  })

  it('masks a value split across chunks without emitting its prefix', () => {
    const m = secretMask({ API_TOKEN: SECRET })!
    const s = m.stream()
    const out = [s.push('before hunter2-'), s.push('l11-sekret after'), s.end()]
    expect(out.join('')).toBe(`before ${MASKED} after`)
    for (const piece of out) expect(piece).not.toContain('hunter2')
  })

  it('names by the words they hold; a short or a plain one is left', () => {
    const m = secretMask({
      NPM_TOKEN: 'aaaaaaaa',
      DB_PASSWORD: 'bbbbbbbb',
      SIGNING_KEY: 'cccccccc',
      MY_SECRET: 'dddddddd',
      API_TOKEN: 'short',
      HOME: 'eeeeeeee',
    })!
    expect(m.mask('aaaaaaaa bbbbbbbb cccccccc dddddddd short eeeeeeee')).toBe(
      `${MASKED} ${MASKED} ${MASKED} ${MASKED} short eeeeeeee`,
    )
    // CONTROL: nothing secret-named, no mask at all; nor a name that says
    // where a secret lives, nor git's config-key channel.
    expect(secretMask({ HOME: '/home/x', PATH: '/bin' })).toBeNull()
    expect(
      secretMask({ NPM_TOKEN_FILE: '/run/secrets/npm', GIT_CONFIG_KEY_0: 'safe.directory' }),
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
    const all = [
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
    }).toEqual({ ok: [true, true], leaked: 0, masked: [true, true, true, true, true] })
  })
})
