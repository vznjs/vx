// Masking the values of secret-named variables in what vx prints, stores or
// hands to telemetry. A task that echoes `$NPM_TOKEN`, or a TS config that
// interpolates `process.env.API_KEY` into its command, put the value in the
// terminal, the cached stdout every later hit replays, and the spans a
// telemetry plugin exports. The masking is GitHub Actions' kind: a known value
// is replaced wherever it appears.

import { ownEnv } from './essential-env.js'
import { limitSetting } from './settle.js'

/**
 * A variable whose value is masked, by the words its name holds: a
 * passphrase (`GPG_PASSPHRASE`) too, and a password's short spelling as a
 * last word (`SMTP_PASS`). Not `_PWD`: `ORIG_PWD` holds a directory, and
 * masking it blanked every path in a task's output.
 */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|_PASS$/i

/**
 * Names that hold such a word but a value that is no secret: where a
 * secret lives (`NPM_TOKEN_FILE`), or git's own config channel, whose
 * `GIT_CONFIG_KEY_<n>` values are config names (`safe.directory`) that
 * masking would blank out of ordinary output.
 */
const NOT_SECRET = /_(FILE|PATH|DIR)$|^GIT_CONFIG_KEY_\d+$/i

/**
 * Each name's verdict, decided once: every task asks it of the whole
 * process env (two regex tests a variable, ~10 µs a call at 150 names).
 * The values are read fresh each time; only the name decides this.
 */
const secretNames = new Map<string, boolean>()

/** Whether vx masks a variable's value by its name alone (`NPM_TOKEN`, not `NPM_TOKEN_FILE`). */
export function secretNamed(name: string): boolean {
  let secret = secretNames.get(name)
  if (secret === undefined) {
    secret = SECRET_NAME.test(name) && !NOT_SECRET.test(name)
    secretNames.set(name, secret)
  }
  return secret
}

/**
 * Values shorter than this are not masked: `KEY=1` would mask every `1`
 * in every line, and a value that short is no secret worth the noise.
 */
const MIN_SECRET_CHARS = 6

export const MASKED = '***'

/**
 * Secrets this process holds that no environment names: a plugin's
 * keychain answers (`ctx.secret`). A server's reply that echoed one
 * printed it whole in the warning, beside masked task output.
 */
const held = new Set<string>()

/** `value` is masked wherever this process's secrets are, from now on. */
export function holdSecret(value: string): void {
  held.add(value)
}

/** How many values `holdSecret` holds: a mask built with fewer is stale. */
export function heldSecrets(): number {
  return held.size
}

export interface SecretMask {
  /** `text` with every secret value replaced. */
  mask(text: string): string
  /** Where `mask` replaces a value in `text`: `[start, end)` pairs, in order. */
  spans(text: string): Array<[start: number, end: number]>
  /**
   * A mask for a stream of chunks: a value split across two chunks is
   * still caught, by holding back only a tail that could begin one until
   * the next chunk or `end`. `release` lets the held tail go before
   * either: a piece of `MIN_SECRET_CHARS` or more as the mask, which the
   * rest of its value then joins.
   */
  stream(): { push(chunk: string): string; release(): string; end(): string }
  /**
   * `spans` over a text given in chunks: each call returns the spans it
   * settled, as offsets into the whole text, the same spans `spans` finds in
   * the text joined.
   */
  spanStream(): {
    push(chunk: string): Array<[start: number, end: number]>
    end(): Array<[start: number, end: number]>
  }
  /**
   * `mask` for the two sides of a cut, where the text between them is
   * gone: a value the cut split leaves a piece at the end of `head` or the
   * start of `tail` that no whole-value match sees, so each piece is
   * masked too.
   */
  maskCut(head: string, tail: string): [string, string]
}

/**
 * The mask for these variables (a process's env, a task's `define`), or
 * null when none is secret-named with a value worth masking: the common
 * run pays one name test per variable and nothing per byte. `named` are
 * the task's `env.secret`: masked whatever the name.
 */
export function secretMask(
  sources: ReadonlyArray<Readonly<Record<string, string | undefined>> | undefined>,
  named: readonly string[] = [],
): SecretMask | null {
  const values = new Set<string>()
  const min = limitSetting('VX_RUN_SECRETS_MIN_LENGTH', MIN_SECRET_CHARS)
  const add = (value: string | undefined): void => {
    if (value === undefined || value.length < min) return
    values.add(value)
    // A secret pasted with a trailing blank or newline prints without it
    // (`echo $T` splits it off, a tool trims it), and the whole value
    // never matched.
    const bare = value.trim()
    if (bare !== value) add(bare)
    // A value with a `'` reaches a printed command spelled as shellQuote spells
    // it (`'\''`), which the plain value does not match.
    if (value.includes("'")) values.add(value.replaceAll("'", `'\\''`))
    // As a tool encodes it: a token's `/+=` in a query string, a quote,
    // backslash or newline inside a JSON string. Either printed it whole.
    for (const url of urlSpellings(value)) if (url !== value) values.add(url)
    for (const b64 of base64Spellings(value)) if (b64.length >= min) values.add(b64)
    const json = JSON.stringify(value).slice(1, -1)
    if (json !== value) values.add(json)
    // Python's json.dumps (`ensure_ascii`): every non-ASCII code unit as `\uXXXX`.
    const ascii = json.replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    )
    if (ascii !== json) values.add(ascii)
    // A multi-line value (a PEM key) is also masked line by line, as GitHub
    // Actions does: a tool that indents or reflows it prints no copy of the
    // whole value, and every line leaked.
    if (!value.includes('\n')) return
    for (const line of value.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length >= min) values.add(trimmed)
    }
  }
  for (const source of sources) {
    if (source === undefined) continue
    for (const name in source) {
      const value = source[name]
      if (secretNamed(name)) add(value)
      if (value?.includes('://') === true && value.includes('@'))
        for (const pw of urlPasswords(value)) add(pw)
    }
    for (const name of named) add(ownEnv(source, name))
  }
  // This process's secrets: the environment's and the held ones.
  if (sources.includes(process.env)) for (const value of held) add(value)
  if (values.size === 0) return null
  const found = [...values]
  for (const m of masks) if (sameValues(m.values, found)) return m.mask
  if (masks.length >= MASKS_KEPT) masks.shift()
  const mask = maskOf(values)
  masks.push({ values: found, mask })
  return mask
}

/**
 * Masks built, with the values each masks: every task of a run asks for
 * the same one, and building it (a sort, a RegExp the engine compiles
 * again) took 30 ms of a cold run's main thread at 500 tasks. The values
 * are read fresh on every call; only the same values reuse a mask.
 */
const masks: Array<{ values: readonly string[]; mask: SecretMask }> = []
const MASKS_KEPT = 8

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Each URL value's passwords, found once: the value decides them. */
const urlPasswordsOf = new Map<string, string[]>()

function urlPasswords(value: string): string[] {
  let found = urlPasswordsOf.get(value)
  if (found === undefined) {
    found = []
    for (const pw of urlPasswordsIn(value)) {
      found.push(pw)
      // A driver's error or config dump prints it decoded (`p@ss` for `p%40ss`).
      try {
        const plain = decodeURIComponent(pw)
        if (plain !== pw) found.push(plain)
      } catch {
        // not a valid escape: printed as written
      }
    }
    urlPasswordsOf.set(value, found)
  }
  return found
}

/**
 * A URL's password (`postgres://app:<pw>@db/app`): a credential whatever
 * the variable is named, so `DATABASE_URL` and `REDIS_URL` printed it.
 * Split as WHATWG splits it: the userinfo ends at the LAST `@` before the
 * path, query or fragment, and the user name at its first `:`, so either
 * may hold an `@` (`app:p@ss@db` printed `p@ss` whole). What
 * `/[a-z][a-z0-9+.-]*:\/\/[^\s:/?#]*:([^\s/?#]+)@/gi` captures, in linear
 * time: that regex tried every letter of a scheme-like run as a start and
 * rescanned the rest from each (120 ms for a 20 KB value, seconds past it).
 */
export function urlPasswordsIn(value: string): string[] {
  const found: string[] = []
  let from = 0
  for (let at = value.indexOf('://'); at !== -1; at = value.indexOf('://', at + 1)) {
    // The scheme: a letter, then scheme characters up to `://`, no earlier
    // than the last match's end.
    let start = at
    while (start > from && SCHEME_CHAR.test(value[start - 1]!)) start--
    while (start < at && !LETTER.test(value[start]!)) start++
    if (start === at) continue
    let user = at + 3
    while (user < value.length && USER_CHAR.test(value[user]!)) user++
    if (value[user] !== ':') continue
    let end = user + 1
    while (end < value.length && PASSWORD_CHAR.test(value[end]!)) end++
    const sign = value.lastIndexOf('@', end - 1)
    if (sign <= user + 1) continue
    found.push(value.slice(user + 1, sign))
    from = sign + 1
    at = sign
  }
  return found
}

const SCHEME_CHAR = /[a-z0-9+.-]/i
const LETTER = /[a-z]/i
const USER_CHAR = /[^\s:/?#]/
const PASSWORD_CHAR = /[^\s/?#]/

const UNRESERVED = /^[\w.-]*$/

/**
 * A value as URL encoders spell it. Each escapes its own set:
 * encodeURIComponent keeps `!'()*`, curl and Python's quote() escape them,
 * quote() keeps `/`, curl and quote_plus() write a space `+`, and
 * URLSearchParams also escapes `~` and keeps `*`.
 */
function urlSpellings(value: string): string[] {
  // No encoder escapes these: the common token (hex, a UUID) has one spelling.
  if (UNRESERVED.test(value)) return []
  const js = encodeURIComponent(value)
  const strict = js.replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  const plus = strict.replaceAll('%20', '+')
  return [
    js,
    strict,
    strict.replaceAll('%2F', '/'),
    plus,
    plus.replaceAll('%2A', '*').replaceAll('~', '%7E'),
  ]
}

/**
 * The value's run in any base64 (`printf %s "$T" | base64`, a Basic auth
 * header's `user:token`) and base64url (a JWT): the characters that hold
 * only its bits, at each of the three offsets a prefix can put it, as
 * GitHub Actions masks it. The edge characters that also hold a
 * neighbour's bits are left out.
 */
function base64Spellings(value: string): string[] {
  // One buffer, two zero bytes ahead of the value: each offset encodes from
  // its own start, with no copy per offset.
  const n = Buffer.byteLength(value)
  const buf = Buffer.alloc(n + 2)
  buf.write(value, 2)
  const out: string[] = []
  for (let shift = 0; shift < 3; shift++) {
    const total = n + shift
    const chars = Math.ceil((total * 4) / 3)
    const end = total % 3 === 0 ? chars : chars - 1
    const run = buf.toString('base64', 2 - shift).slice([0, 2, 3][shift], end)
    out.push(run, run.replaceAll('+', '-').replaceAll('/', '_'))
  }
  return out
}

/**
 * A value as the mask's pattern matches it: literal, but a percent escape's
 * hex in either case (RFC 3986 § 2.1). `encodeURIComponent` prints `%2F`,
 * other tools `%2f` or a mix, and each printed the value whole.
 */
function valuePattern(value: string): string {
  return value
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(
      /%([0-9A-Fa-f])([0-9A-Fa-f])/g,
      (_, a: string, b: string) => `%${hexEither(a)}${hexEither(b)}`,
    )
}

const hexEither = (c: string): string =>
  /[0-9]/.test(c) ? c : `[${c.toLowerCase()}${c.toUpperCase()}]`

function maskOf(values: ReadonlySet<string>): SecretMask {
  // Longest first, so the value tried first at a position is the longest
  // there.
  const sorted = [...values].sort((a, b) => b.length - a.length)
  // A lookahead matches at every position, not only past the last match:
  // a value overlapping another's end (`${A}xyz789` where B is A's tail +
  // `xyz789`) is found too, and the union is masked (`***xyz789` leaked).
  const pattern = new RegExp(`(?=(${sorted.map(valuePattern).join('|')}))`, 'g')
  /** Where values sit in `text`: overlapping or adjacent ones merged, in order. */
  const spans = (text: string): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    pattern.lastIndex = 0
    for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
      const end = m.index + m[1]!.length
      const last = out.at(-1)
      if (last !== undefined && m.index <= last[1]) last[1] = Math.max(last[1], end)
      else out.push([m.index, end])
      pattern.lastIndex = m.index + 1
    }
    return out
  }
  const mask = (text: string): string => render(text, spans(text))
  const render = (text: string, found: ReadonlyArray<[number, number]>): string => {
    if (found.length === 0) return text
    let out = ''
    let at = 0
    for (const [s, e] of found) {
      out += text.slice(at, s) + MASKED
      at = e
    }
    return out + text.slice(at)
  }
  // A value's percent escapes match in either case, so a piece of one is
  // compared folded: folding more only holds a tail back a little longer.
  const folds = sorted.map((v) => (v.includes('%') ? v.toLowerCase() : undefined))
  const piece = (text: string, at: number): string =>
    folds[at] === undefined ? text : text.toLowerCase()
  /** The longest tail of `text` that is a proper prefix of a value. */
  const partialTail = (text: string): number => {
    let longest = 0
    for (const [i, raw] of sorted.entries()) {
      const v = folds[i] ?? raw
      const t = piece(text, i)
      // A prefix ends on the text's last character: a compare of one
      // character skips each other length (15 spellings a secret made the
      // whole compare 5x slower per chunk).
      const last = t.charCodeAt(t.length - 1)
      for (let k = Math.min(v.length - 1, t.length); k > longest; k--) {
        if (v.charCodeAt(k - 1) === last && t.endsWith(v.slice(0, k))) {
          longest = k
          break
        }
      }
    }
    return longest
  }
  /** The longest head of `text` that is a proper suffix of a value. */
  const partialHead = (text: string): number => {
    let longest = 0
    for (const [i, raw] of sorted.entries()) {
      const v = folds[i] ?? raw
      const t = piece(text, i)
      const first = t.charCodeAt(0)
      for (let k = Math.min(v.length - 1, t.length); k > longest; k--) {
        if (v.charCodeAt(v.length - k) === first && t.startsWith(v.slice(v.length - k))) {
          longest = k
          break
        }
      }
    }
    return longest
  }
  /**
   * Where `text` may be cut: nothing after it could begin a value. A span
   * may run across it: it is whole in `text`, and its rest is masked from
   * there. Cutting before it held a run of back-to-back values (a value of
   * zeros in a run of zeros) whole and scanned it again on every chunk.
   */
  const cutOf = (text: string): number => text.length - partialTail(text)
  return {
    mask,
    spans,
    maskCut(head, tail) {
      let h = head.length - partialTail(head)
      for (const [s, e] of spans(head)) if (s < h && e >= h) h = s
      let t = partialHead(tail)
      for (const [s, e] of spans(tail)) if (s <= t && e > t) t = e
      return [
        mask(head.slice(0, h)) + (h < head.length ? MASKED : ''),
        (t > 0 ? MASKED : '') + mask(tail.slice(t)),
      ]
    },
    spanStream() {
      let carry = ''
      // Where `carry` starts in the whole text.
      let base = 0
      // The last span found: one starting where it ends joins it, as in `spans`.
      let last: [number, number] | undefined
      const settle = (found: ReadonlyArray<[number, number]>, upTo: number) => {
        const out: Array<[number, number]> = []
        for (const [s, e] of found) {
          if (s >= upTo) break
          if (last !== undefined && base + s <= last[1]) last[1] = Math.max(last[1], base + e)
          else {
            if (last !== undefined) out.push(last)
            last = [base + s, base + e]
          }
        }
        return out
      }
      return {
        push(chunk) {
          const text = carry + chunk
          const found = spans(text)
          const cut = cutOf(text)
          const out = settle(found, cut)
          carry = text.slice(cut)
          base += cut
          return out
        },
        end() {
          const out = settle(spans(carry), carry.length)
          if (last !== undefined) out.push(last)
          carry = ''
          last = undefined
          return out
        },
      }
    },
    stream() {
      let carry = ''
      // How many characters at `carry`'s start already went out as a mask
      // (`release`): a value they begin joins that mask, and they are never
      // shown again.
      let ghost = 0
      // What went out ends in a mask: a value starting right after it joins
      // that mask, as in the whole text. Holding the span back for that held
      // back-to-back values forever and re-scanned them per chunk.
      let joined = false
      // How many characters at `carry`'s start already went out as written:
      // a piece `release` let go too short to mask. A value they begin is
      // masked from where they end, so its rest never shows: `printf
      // 'key=hun'; sleep 0.3; printf 'ter2…'` showed the whole value.
      let plain = 0
      const out = (
        text: string,
        shown: number,
        found: ReadonlyArray<[number, number]> = spans(text),
        written = 0,
      ): string => {
        const from = Math.max(shown, written)
        if (text.length <= from) return ''
        let masked = ''
        let at = from
        for (const [s, e] of found) {
          if (e <= at) continue
          if (s < written && s >= shown) {
            masked += MASKED
            at = e
            continue
          }
          if (s < shown || (s <= at && joined && at === shown)) {
            at = e
            continue
          }
          masked += text.slice(at, s) + MASKED
          at = e
        }
        masked += text.slice(at)
        joined = found.at(-1)?.[1] === text.length
        return masked
      }
      return {
        push(chunk) {
          const text = carry + chunk
          // Held back: only a tail that could begin a value, so output that
          // cannot be one is never delayed (a `readyWhen` line, a marker).
          const found = spans(text)
          const cut = cutOf(text)
          carry = text.slice(cut)
          const shown = Math.min(ghost, cut)
          ghost -= shown
          const written = plain
          plain = Math.max(0, plain - cut)
          // A span across the cut is masked up to it, and its rest is never
          // shown: a ghost, which a value it begins joins.
          const before: Array<[number, number]> = []
          // A value begun in what went out as written whose shown part ends
          // at the cut: `out` has no character of it left to mask, so it
          // says nothing, and its rest is a ghost. Its mask goes out here.
          let unsaid = false
          for (const [s, e] of found) {
            if (s >= cut) break
            before.push([s, Math.min(e, cut)])
            if (e > cut) {
              ghost = Math.max(ghost, e - cut)
              unsaid = s >= shown && s < written && cut <= written
            }
          }
          const shownText = out(text.slice(0, cut), shown, before, written)
          if (!unsaid) return shownText
          joined = true
          return shownText + MASKED
        },
        release() {
          // A piece too short to say much goes out as written, kept so the
          // rest of a value it begins goes out as the mask; a longer one
          // goes out as the mask, kept to join the rest of its value.
          const piece = partialTail(carry)
          if (piece < MIN_SECRET_CHARS) {
            const rest = out(carry, ghost, spans(carry), plain)
            carry = carry.slice(carry.length - piece)
            plain = piece
            ghost = 0
            return rest
          }
          const cut = carry.length - piece
          const head = out(
            carry.slice(0, cut),
            Math.min(ghost, cut),
            undefined,
            Math.min(plain, cut),
          )
          const fresh = ghost <= cut
          carry = carry.slice(cut)
          ghost = carry.length
          plain = 0
          const result = head + (fresh && !joined ? MASKED : '')
          joined = true
          return result
        },
        end() {
          const rest = out(carry, ghost, undefined, plain)
          carry = ''
          ghost = 0
          plain = 0
          return rest
        },
      }
    },
  }
}

/** A task's command as vx shows it: its secret values masked. */
export function maskedCommand(command: string, env?: TaskEnvSecrets): string {
  return secretMask([process.env, env?.define], env?.secret)?.mask(command) ?? command
}

/** A line vx prints for no one task (a plugin's warning): this process's secrets masked. */
export function maskedLine(line: string): string {
  return secretMask([process.env])?.mask(line) ?? line
}

/** What of a task's `exec.env` names its secrets. */
export interface TaskEnvSecrets {
  readonly define?: Readonly<Record<string, string>>
  readonly secret?: readonly string[]
}

/**
 * Each stream's run of adjacent non-empty chunks joined, with `mask`
 * applied to each stream's text as a whole: a value is masked where it
 * starts and its rest dropped from the runs it reaches. The live stream
 * masks chunk by chunk and lets a held piece go after a pause, so a value
 * written in two pieces reached the capture in two chunks, and a write to
 * the other stream between them made them two runs. A hit replays each
 * stream to its own descriptor, so `vx run > log` joined them again.
 */
export function maskStreams(
  chunks: ReadonlyArray<{ text: string; err: boolean }>,
  mask: SecretMask | undefined,
): Array<{ text: string; err: boolean }> {
  if (mask === undefined) return chunks.filter((c) => c.text.length > 0)
  const runs: Array<{ text: string; err: boolean }> = []
  for (const c of chunks) {
    if (c.text.length === 0) continue
    const last = runs.at(-1)
    if (last !== undefined && last.err === c.err) last.text += c.text
    else runs.push({ text: c.text, err: c.err })
  }
  for (const err of [false, true]) {
    const own = runs.filter((r) => r.err === err)
    const spans = mask.spans(own.map((r) => r.text).join(''))
    if (spans.length === 0) continue
    let at = 0
    let i = 0
    for (const r of own) {
      const end = at + r.text.length
      let text = ''
      let from = at
      for (; i < spans.length && spans[i]![0] < end; i++) {
        const [s, e] = spans[i]!
        if (s >= from) text += r.text.slice(from - at, s - at) + MASKED
        from = Math.max(from, Math.min(e, end))
        // A value that runs past this run is cut from the next one too.
        if (e > end) break
      }
      r.text = text + r.text.slice(from - at)
      at = end
    }
  }
  // A run emptied whole leaves its neighbours, the other stream, adjacent.
  const kept: typeof runs = []
  for (const r of runs) {
    if (r.text.length === 0) continue
    const last = kept.at(-1)
    if (last !== undefined && last.err === r.err) last.text += r.text
    else kept.push(r)
  }
  return kept
}

/**
 * `mask.stream()` driving `emit`: what it holds back (a tail that could
 * begin a value) is released `idleMs` after the last chunk when none
 * follows, so a long task's last characters do not wait for its exit. A
 * released piece of `MIN_SECRET_CHARS` or more goes out as the mask, and
 * the rest of its value joins it: a value split by a longer pause is caught
 * unless its first piece is shorter than that.
 */
function maskedEmitter(
  mask: SecretMask,
  emit: (text: string) => void,
  idleMs = 25,
): { push(chunk: string): void; release(): void; end(): void } {
  const s = mask.stream()
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const release = (): void => {
    stop()
    const rest = s.release()
    if (rest) emit(rest)
  }
  return {
    push(chunk) {
      stop()
      const out = s.push(chunk)
      if (out) emit(out)
      timer = setTimeout(release, idleMs)
      timer.unref?.()
    },
    release,
    end() {
      stop()
      const rest = s.end()
      if (rest) emit(rest)
    },
  }
}

/**
 * A task's two streams, each through `maskedEmitter`, in the order the
 * task wrote them. Each held its own tail, so a stdout tail that could
 * begin a value waited out the idle bound while stderr printed, and the
 * run log, live and cached, put the stderr line first. A chunk on one
 * stream now releases the other's held tail before it, as a pause does.
 */
export function maskedStreams(
  mask: SecretMask,
  emitOut: (text: string) => void,
  emitErr: (text: string) => void,
  idleMs = 25,
): { out(chunk: string): void; err(chunk: string): void; end(): void } {
  const out = maskedEmitter(mask, emitOut, idleMs)
  const err = maskedEmitter(mask, emitErr, idleMs)
  return {
    out(chunk) {
      err.release()
      out.push(chunk)
    },
    err(chunk) {
      out.release()
      err.push(chunk)
    },
    end() {
      out.end()
      err.end()
    },
  }
}
