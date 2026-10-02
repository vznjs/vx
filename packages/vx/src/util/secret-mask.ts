// Masking the values of secret-named variables in what vx prints, stores
// or hands to telemetry (L-11). A task that echoes `$NPM_TOKEN`, or a
// TS config that interpolates `process.env.API_KEY` into its command,
// put the value in the terminal, the cached stdout every later hit
// replays, and the spans a telemetry plugin exports. The masking is
// GitHub Actions' kind: a known value is replaced wherever it appears.

/** A variable whose value is masked, by the words its name holds. */
const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL/i

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

function secretNamed(name: string): boolean {
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

export interface SecretMask {
  /** `text` with every secret value replaced. */
  mask(text: string): string
  /**
   * A mask for a stream of chunks: a value split across two chunks is
   * still caught, by holding back only a tail that could begin one until
   * the next chunk or `end`.
   */
  stream(): { push(chunk: string): string; end(): string }
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
  const add = (value: string | undefined): void => {
    if (value !== undefined && value.length >= MIN_SECRET_CHARS) values.add(value)
  }
  for (const source of sources) {
    if (source === undefined) continue
    for (const name in source) if (secretNamed(name)) add(source[name])
    for (const name of named) add(source[name])
  }
  if (values.size === 0) return null
  // Longest first, so a value holding another is replaced whole.
  const sorted = [...values].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(
    sorted.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  )
  const mask = (text: string): string => text.replace(pattern, MASKED)
  /** The longest tail of `text` that is a proper prefix of a value. */
  const partialTail = (text: string): number => {
    let longest = 0
    for (const v of sorted) {
      for (let k = Math.min(v.length - 1, text.length); k > longest; k--) {
        if (text.endsWith(v.slice(0, k))) {
          longest = k
          break
        }
      }
    }
    return longest
  }
  return {
    mask,
    stream() {
      let carry = ''
      return {
        push(chunk) {
          const text = carry + chunk
          // Held back: only a tail that could begin a value, so output that
          // cannot be one is never delayed (a `readyWhen` line, a marker).
          let cut = text.length - partialTail(text)
          pattern.lastIndex = 0
          // Never cut through a value that is already whole.
          for (let m = pattern.exec(text); m !== null; m = pattern.exec(text)) {
            if (m.index < cut && m.index + m[0].length > cut) cut = m.index
          }
          carry = text.slice(cut)
          return mask(text.slice(0, cut))
        },
        end() {
          const rest = mask(carry)
          carry = ''
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

/** What of a task's `exec.env` names its secrets. */
export interface TaskEnvSecrets {
  readonly define?: Readonly<Record<string, string>>
  readonly secret?: readonly string[]
}

/**
 * `mask.stream()` driving `emit`: what it holds back (a tail that could
 * begin a value) is emitted `idleMs` after the last chunk when none
 * follows, so a long task's last characters do not wait for its exit. A
 * value is written whole or in chunks that arrive together; one split by
 * a pause longer than that is not caught.
 */
export function maskedEmitter(
  mask: SecretMask,
  emit: (text: string) => void,
  idleMs = 25,
): { push(chunk: string): void; end(): void } {
  const s = mask.stream()
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const rest = s.end()
    if (rest) emit(rest)
  }
  return {
    push(chunk) {
      if (timer !== undefined) clearTimeout(timer)
      const out = s.push(chunk)
      if (out) emit(out)
      timer = setTimeout(end, idleMs)
      timer.unref?.()
    },
    end,
  }
}
