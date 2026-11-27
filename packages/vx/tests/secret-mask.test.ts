// A secret-named variable's value never reaches the terminal, the cached
// stdout a hit replays, a telemetry record or `vx show` (L-11). A task
// that echoed `$API_TOKEN`, or a config that built its command from
// `process.env`, put the value in all four.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { run as runFromLock } from '../src/orchestrator/index.js'
import { storedLog } from '../src/cache/index.js'
import { decodeOutputLog } from '../src/orchestrator/output-log.js'
import { lock, run } from './helpers/orchestrator.js'
import { defaultLogger } from '../src/report/logger.js'
import { MASKED, maskedStreams, secretMask } from '../src/util/index.js'
import { urlPasswordsIn } from '../src/util/secret-mask.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { writeLocalWorkspace } from './helpers/local-workspace.js'

const SECRET = 'hunter2-l11-sekret'
const DEFINED = 'defined-l11-sekret'

describe('secretMask', () => {
  it('spanStream finds the spans `spans` finds in the text joined, however it is cut', () => {
    // A value overlapping another's end, back-to-back values, a value that
    // is a prefix of a longer one, and an escape's hex in either case.
    const mask = secretMask([
      { API_TOKEN: 'abcdef123', B_TOKEN: 'f123xyz789', C_KEY: 'abcdef1234567', D_KEY: 'p@ss/w0rd' },
    ])!
    const text =
      'x abcdef123xyz789 abcdef123abcdef123 abcdef1234567 abcdef12 p%40ss%2Fw0rd p%40ss%2fw0rd y'
    let seed = 7
    const random = (n: number): number => (seed = (seed * 48271) % 2147483647) % n
    for (let round = 0; round < 200; round++) {
      const s = mask.spanStream()
      const got: Array<[number, number]> = []
      for (let at = 0; at < text.length;) {
        const end = Math.min(text.length, at + 1 + random(12))
        got.push(...s.push(text.slice(at, end)))
        at = end
      }
      got.push(...s.end())
      expect(got).toEqual(mask.spans(text))
    }
  })

  it('holds back only a tail that could begin a value; other output passes at once', () => {
    const s = secretMask([{ API_TOKEN: SECRET }])!.stream()
    // A persistent task's `readyWhen` and a test's start marker read the
    // chunk as it comes: nothing of it may wait for the next one.
    expect(s.push('server ready\n')).toBe('server ready\n')
    expect(s.push('tail hun')).toBe('tail ')
    expect(s.push('gry\n')).toBe('hungry\n')
    expect(s.end()).toBe('')
  })

  // Back-to-back values make one span reaching each chunk's end: cut before
  // it, the stream held the whole run and scanned it again per chunk
  // (1.6 MB of zeros with a value of zeros: 17 s).
  it('streams a long run of back-to-back values in time linear in its length', () => {
    const m = secretMask([{ DB_PASSWORD: '000000000' }])!
    const chunk = '0'.repeat(4000)
    const t = performance.now()
    const s = m.stream()
    let out = ''
    const f = m.spanStream()
    const found: Array<[number, number]> = []
    for (let i = 0; i < 400; i++) {
      out += s.push(chunk)
      found.push(...f.push(chunk))
    }
    out += s.push('\nok') + s.end()
    found.push(...f.end())
    expect(performance.now() - t).toBeLessThan(3_000)
    expect(out).toBe(`${MASKED}\nok`)
    expect(found).toEqual([[0, 1_600_000]])
  })

  it('maskCut masks the pieces a cut leaves, a whole value across one, and nothing else', () => {
    const m = secretMask([{ API_TOKEN: SECRET }])!
    expect(m.maskCut('a hunter', '-l11-sekret b')).toEqual([`a ${MASKED}`, `${MASKED} b`])
    // A whole value that ends past where a piece would start goes whole.
    const r = secretMask([{ API_TOKEN: 'abcabcabc' }])!
    expect(r.maskCut('x abcabcabc', 'abcabcabc y')).toEqual([`x ${MASKED}`, `${MASKED} y`])
    expect(m.maskCut(`a ${SECRET} b`, `c ${SECRET} d`)).toEqual([`a ${MASKED} b`, `c ${MASKED} d`])
    expect(m.maskCut('plain', 'words')).toEqual(['plain', 'words'])
  })

  // `${A}xyz789` printed `***xyz789`: one alternation replaced A and
  // resumed past it, so B, which overlaps A's end, was never matched.
  it('masks the union of overlapping and adjacent values', () => {
    const m = secretMask([{ A_TOKEN: 'abcdef123456', B_TOKEN: '123456xyz789' }])!
    expect(m.mask('x abcdef123456xyz789 y')).toBe(`x ${MASKED} y`)
    expect(m.mask('abcdef123456123456xyz789')).toBe(MASKED)
    expect(m.spans('abcdef123456xyz789!')).toEqual([[0, 18]])
    const s = m.stream()
    const streamed =
      ['abcdef', '123456', 'xyz', '789 done'].map((c) => s.push(c)).join('') + s.end()
    expect(streamed).toBe(`${MASKED} done`)
    expect(m.maskCut('a abcdef123456xyz789', 'b')).toEqual([`a ${MASKED}`, 'b'])
  })

  // A span ending where a held tail began was held whole, to merge with a
  // value the next chunk might complete: back-to-back values in chunks that
  // each end inside one (a placeholder `xxxxxx` key and a run of `x`) held
  // the whole stream, emitted nothing, and re-scanned it per chunk (47 s at 9 MB).
  it('emits back-to-back values as they come, masked as the whole text is', () => {
    const m = secretMask([{ API_TOKEN: SECRET }])!
    const s = m.stream()
    const chunk = `${SECRET.slice(5)}${SECRET}${SECRET.slice(0, 5)}`
    let all = SECRET.slice(0, 5)
    let out = s.push(all)
    for (let i = 0; i < 3; i++) {
      const piece = s.push(chunk)
      all += chunk
      // The first value goes out at once; the rest join its mask.
      expect(piece).toBe(i === 0 ? MASKED : '')
      out += piece
    }
    out += s.push(`${SECRET.slice(5)} done`) + s.end()
    expect(out).toBe(m.mask(`${all}${SECRET.slice(5)} done`))
    expect(out).toBe(`${MASKED} done`)
  })

  it("a URL's password is masked whatever the variable is named", () => {
    const m = secretMask([
      {
        DATABASE_URL: 'postgres://app:pw-l11-sekret@db:5432/app',
        MIRROR: 'see https://u:mirror-l11-sekret@a.example and ftp://v:second-l11-sekret@b/',
      },
    ])!
    expect(m.mask('connect postgres://app:pw-l11-sekret@db:5432/app')).toBe(
      `connect postgres://app:${MASKED}@db:5432/app`,
    )
    expect(m.mask('mirror-l11-sekret second-l11-sekret')).toBe(`${MASKED} ${MASKED}`)
    // A URL splits its userinfo at the LAST `@` before the host (WHATWG):
    // a password holding `@`, or a user name holding one, printed whole.
    const at = secretMask([
      {
        DATABASE_URL: 'postgres://app:p@ssw0rd99@db:5432/app',
        CACHE_URL: 'redis://me@corp:cache-pw-77@cache:6379/0?x=a@b#y@z',
      },
    ])!
    expect(at.mask('postgres://app:p@ssw0rd99@db:5432/app redis://me@corp:cache-pw-77@cache')).toBe(
      `postgres://app:${MASKED}@db:5432/app redis://me@corp:${MASKED}@cache`,
    )
    expect(at.mask('p@ssw0rd99 cache-pw-77 a@b')).toBe(`${MASKED} ${MASKED} a@b`)
    // CONTROL: a URL with no password, an email, and a short password mask nothing.
    expect(
      secretMask([
        {
          HOME_URL: 'https://user@example.com/x',
          AUTHOR: 'dev@example.com',
          SHORT_URL: 'redis://:pw@cache',
        },
      ]),
    ).toBeNull()
  })

  // The URL-password regex tried each letter of a scheme-like run as a
  // start and rescanned the rest from each: a 20 KB env value holding
  // `://` and `@` took 120 ms of every run's start, 60 KB over a second.
  it("finds a URL's passwords in linear time, as the regex did", () => {
    const REGEX = /[a-z][a-z0-9+.-]*:\/\/[^\s:/?#]*:([^\s/?#]+)@/gi
    const ref = (v: string): string[] => [...v.matchAll(REGEX)].map((m) => m[1]!)
    const chars = [
      'a',
      'Z',
      '1',
      '+',
      ':',
      '/',
      '@',
      ' ',
      '?',
      '#',
      '-',
      '://',
      'u:',
      'pw@',
      'x://u:',
    ]
    let seed = 7
    const next = (n: number): number => {
      seed = (seed * 48271) % 2147483647
      return seed % n
    }
    for (let i = 0; i < 20_000; i++) {
      let v = ''
      for (let k = next(24); k > 0; k--) v += chars[next(chars.length)]
      expect(urlPasswordsIn(v)).toEqual(ref(v))
    }
    for (const v of [
      'postgres://app:p@ss@db/x https://u:v@h a://b:c@d://e:f@g',
      'redis://me@corp:pw@cache:6379/0?x=a@b',
      'x1://u:p@h 1a://u:q@h ://u:r@h',
    ])
      expect(urlPasswordsIn(v)).toEqual(ref(v))
    const worst = [
      `@${'a'.repeat(60_000)}://x`,
      `${'a'.repeat(30_000)}://u:${'b'.repeat(30_000)} @`,
    ]
    for (const v of worst) {
      const t = performance.now()
      expect(urlPasswordsIn(v)).toEqual([])
      expect(performance.now() - t).toBeLessThan(100)
    }
  })

  it('a held tail is emitted once no chunk follows it', async () => {
    const got: string[] = []
    const e = maskedStreams(
      secretMask([{ API_TOKEN: SECRET }])!,
      (t) => void got.push(t),
      () => {},
      20,
    )
    e.out('progress hun')
    expect(got.join('')).toBe('progress ')
    // The shortest wait that shows it: well past the idle bound.
    await Bun.sleep(80)
    expect(got.join('')).toBe('progress hun')
  })

  // The idle bound let a held piece go as written: `printf 'key=hunter2-l1';
  // sleep 0.3; printf '1-sekret'` showed both pieces plain, the whole value
  // on the terminal of a single-task run. A piece of six characters or more
  // goes out as the mask, and the rest that completes it joins that mask.
  it('masks a value a pause splits, once its piece is six characters', async () => {
    const got: string[] = []
    const e = maskedStreams(
      secretMask([{ API_TOKEN: SECRET }])!,
      (t) => void got.push(t),
      () => {},
      20,
    )
    e.out('key=hunter2-l')
    await Bun.sleep(80)
    expect(got.join('')).toBe(`key=${MASKED}`)
    e.out('1')
    await Bun.sleep(80)
    e.out('1-sekret done\n')
    e.end()
    expect(got.join('')).toBe(`key=${MASKED} done\n`)
    for (const piece of got) expect(piece).not.toMatch(/hunter|sekret/)
  })

  // Each stream held its own tail: a stdout tail that could begin a value
  // waited out the idle bound while stderr printed, and the run log, live
  // and cached, put the stderr line before text the task wrote first.
  it('keeps the order of the two streams across a held tail', () => {
    const got: string[] = []
    const s = maskedStreams(
      secretMask([{ API_TOKEN: SECRET }])!,
      (t) => void got.push(`out:${t}`),
      (t) => void got.push(`err:${t}`),
    )
    s.out('progress hun')
    s.err('ERROR\n')
    s.out(`ter ${SECRET}\n`)
    s.end()
    expect(got).toEqual(['out:progress ', 'out:hun', 'err:ERROR\n', `out:ter ${MASKED}\n`])
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

  it("names a passphrase and a password's short spelling, _PASS", () => {
    const m = secretMask([
      { GPG_PASSPHRASE: 'aaaaaaaa', SMTP_PASS: 'bbbbbbbb', REDIS_PASS: 'cccccccc' },
    ])!
    expect(m.mask('aaaaaaaa bbbbbbbb cccccccc')).toBe(`${MASKED} ${MASKED} ${MASKED}`)
    // CONTROL: the shell's own directories, and a word that only holds PASS.
    expect(
      secretMask([
        {
          PWD: '/home/x/app',
          OLDPWD: '/home/x',
          ORIG_PWD: '/home/x/ws',
          COMPASS: 'northwest',
          BYPASS_X: 'yes-please',
        },
      ]),
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
              inputs: { files: ['in.txt'] }, outputs: { files: ['out.txt'] }, cache: true,
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

  // `vx lock` refuses a config that evaluated to a secret in its own
  // environment; one locked where the variable was unset still reaches a
  // run where it is set, and the mask is what keeps the value off screen.
  const lockWithoutSecret = async (): Promise<void> => {
    delete process.env['API_TOKEN']
    try {
      await lock(root)
    } finally {
      process.env['API_TOKEN'] = SECRET
    }
  }

  const once = async () => {
    const chunks: string[] = []
    const records: unknown[] = []
    const out = { write: (c: string) => (chunks.push(c), true) }
    const r = await runFromLock({
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
    await lockWithoutSecret()
    const chunks: string[] = []
    const r = await runFromLock({
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
    await lockWithoutSecret()
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

// A value written in two pieces with a pause between them outlasted the
// live stream's 25 ms hold, so the terminal showed it whole. The stored
// copies did too: the entry's stdout (which a hit replays and a remote
// cache receives) and the failure record `vx last` reads kept the raw
// value, though only the terminal cannot be taken back.
describe('a value split by a pause is masked in every stored copy', () => {
  let root: string
  const saved = process.env['API_TOKEN']
  beforeEach(async () => {
    process.env['API_TOKEN'] = SECRET
    root = await makeWorkspace({ prefix: 'vx-split-' })
    await writeLocalWorkspace(root)
  })
  afterEach(async () => {
    if (saved === undefined) delete process.env['API_TOKEN']
    else process.env['API_TOKEN'] = saved
    await rm(root, { recursive: true, force: true })
  })
  const split = (exit: number, between = ''): string =>
    `printf %s "$API_TOKEN" | head -c 7; ${between}sleep 0.2; printf "%s\\n" "$API_TOKEN" | tail -c +8; echo done > out.txt; exit ${exit}`
  const project = (exit: number, between?: string): Promise<string> =>
    addProject(root, 'p', {
      files: { 'in.txt': 'x' },
      config: `
        export default {
          tasks: {
            t: {
              exec: { command: ${JSON.stringify(split(exit, between))}, env: { passThrough: ['API_TOKEN'] } },
              inputs: { files: ['in.txt'] }, outputs: { files: ['out.txt'] }, cache: true,
            },
          },
        }
      `,
    })
  const quiet = defaultLogger({ enabled: false }, { mode: 'focused' }, { write: () => true })
  const runOnce = async (exit: number, between?: string) => {
    await project(exit, between)
    delete process.env['API_TOKEN']
    await lock(root)
    process.env['API_TOKEN'] = SECRET
    return runFromLock({ cwd: root, tasks: ['t'], log: quiet, handleSignals: false })
  }

  it("the entry's stored stdout", async () => {
    const r = await runOnce(0)
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
    const stored = db
      .query<{ stdout: Uint8Array }, []>('SELECT stdout FROM entry_stdout')
      .all()
      .map((row) => storedLog(row.stdout))
      .join('\n')
    db.close()
    expect({ ok: r.ok, leaked: stored.includes(SECRET), masked: stored.includes(MASKED) }).toEqual({
      ok: true,
      leaked: false,
      masked: true,
    })
  })

  // A hit replays each stream to its own descriptor, so `vx run t > log`
  // wrote stdout's two pieces into one file whole: a stderr write in the
  // pause split the stream's text into two runs, each masked alone.
  it("the entry's stored stdout, a stderr write in the pause", async () => {
    const r = await runOnce(0, 'sleep 0.1; echo working >&2; ')
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
    const stored = storedLog(
      db.query<{ stdout: Uint8Array }, []>('SELECT stdout FROM entry_stdout').get()!.stdout,
    )
    db.close()
    const stream = (err: boolean): string =>
      decodeOutputLog(stored)
        .filter((c) => c.err === err)
        .map((c) => c.text)
        .join('')
    expect({ ok: r.ok, stdout: stream(false), stderr: stream(true) }).toEqual({
      ok: true,
      stdout: `${MASKED}\n`,
      stderr: 'working\n',
    })
  })

  // A telemetry sink got the live chunks, whose held piece the 25 ms
  // bound had let go: vx-otel's buffer joined them into the value.
  it('the telemetry task.log records', async () => {
    await project(0)
    delete process.env['API_TOKEN']
    await lock(root)
    process.env['API_TOKEN'] = SECRET
    const chunks: string[] = []
    const r = await runFromLock({
      cwd: root,
      tasks: ['t'],
      log: quiet,
      handleSignals: false,
      telemetrySinks: [
        {
          wants: ['task.log'],
          onRecord: (rec) => {
            if (rec.kind === 'task.log') chunks.push(rec.chunk)
          },
        },
      ],
    })
    expect({ ok: r.ok, log: chunks.join('') }).toEqual({ ok: true, log: `${MASKED}\n` })
  })

  it('the failure record', async () => {
    const r = await runOnce(1)
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'), { readonly: true })
    const stored = (db.query('SELECT output FROM failures').all() as { output: string }[])
      .map((r) => r.output)
      .join('\n')
    db.close()
    expect({ ok: r.ok, leaked: stored.includes(SECRET), masked: stored.includes(MASKED) }).toEqual({
      ok: false,
      leaked: false,
      masked: true,
    })
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
              inputs: { files: ['in.txt'] }, outputs: { files: [] }, cache: true,
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
      .query<{ stdout: Uint8Array }, []>('SELECT stdout FROM entry_stdout')
      .all()
      .map((r) => storedLog(r.stdout))
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
