import path from 'node:path'

/** `run.rules.dependencies`' entry, as core takes it. */
interface DependencyRule {
  from: string
  allow?: string[]
  deny?: string[]
}

const RULE_NAMES = ['@nx/enforce-module-boundaries', '@nrwl/nx/enforce-module-boundaries']
const FLAT = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.cjs', 'eslint.config.ts']
const LEGACY = ['.eslintrc.json', '.eslintrc']

/**
 * The root ESLint config's `@nx/enforce-module-boundaries` `depConstraints`,
 * as vx's lock-time dependency rules. A flat config is read, never run:
 * importing it loads ESLint's plugins on every vx run, for a rule only
 * `vx lock` checks. So the constraints must be a literal array there; a
 * spread or a variable maps nothing. Undefined when no rule is found.
 */
export async function nxDependencyRules(root: string): Promise<DependencyRule[] | undefined> {
  for (const name of [...FLAT, ...LEGACY]) {
    const file = Bun.file(path.join(root, name))
    if (!(await file.exists())) continue
    const text = await file.text()
    const constraints = LEGACY.includes(name) ? fromJson(text) : fromSource(text)
    return constraints === undefined ? undefined : mapConstraints(constraints)
  }
  return undefined
}

/** `rules` and each `overrides[].rules` of a JSON config, first rule found. */
function fromJson(text: string): unknown[] | undefined {
  let json: unknown
  try {
    json = Bun.JSONC.parse(text)
  } catch {
    return undefined
  }
  const configs = [json, ...((json as { overrides?: unknown[] })?.overrides ?? [])]
  for (const c of configs) {
    const rules = (c as { rules?: Record<string, unknown> } | null)?.rules
    for (const r of RULE_NAMES) {
      const entry = rules?.[r]
      const options = Array.isArray(entry) ? entry[1] : undefined
      const dc = (options as { depConstraints?: unknown } | undefined)?.depConstraints
      if (Array.isArray(dc)) return dc
    }
  }
  return undefined
}

/** The literal after the rule's `depConstraints:` in JS source. */
function fromSource(text: string): unknown[] | undefined {
  for (const r of RULE_NAMES) {
    const at = text.indexOf(r)
    if (at === -1) continue
    const m = /depConstraints['"]?\s*:\s*\[/.exec(text.slice(at))
    if (m === null) return undefined
    try {
      const v = new Literal(text, at + m.index + m[0].length - 1).value()
      return Array.isArray(v) ? v : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Nx's constraint as a vx rule: `sourceTag` is `from`,
 * `onlyDependOnLibsWithTags` is `allow`, `notDependOnLibsWithTags` is
 * `deny`; `*` means any project. A constraint vx cannot say is left out:
 * `allSourceTags` (every tag at once), a `/regex/` tag, or one that bans
 * only external imports.
 */
function mapConstraints(constraints: unknown[]): DependencyRule[] {
  const out: DependencyRule[] = []
  const sel = (t: unknown) => (t === '*' ? '*' : `tag:${String(t)}`)
  const tags = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((t) => typeof t === 'string' && t !== '' && !t.startsWith('/'))
      ? v.map(sel)
      : undefined
  for (const c of constraints) {
    const { sourceTag, onlyDependOnLibsWithTags, notDependOnLibsWithTags } = (c ?? {}) as Record<
      string,
      unknown
    >
    if (typeof sourceTag !== 'string' || sourceTag === '' || sourceTag.startsWith('/')) continue
    const allow = tags(onlyDependOnLibsWithTags)
    const deny = tags(notDependOnLibsWithTags)
    if (allow === undefined && deny === undefined) continue
    out.push({
      from: sel(sourceTag),
      ...(allow !== undefined ? { allow } : {}),
      ...(deny !== undefined ? { deny } : {}),
    })
  }
  return out
}

/** A JS literal: arrays, objects, strings, numbers, booleans, null. Anything else throws. */
class Literal {
  constructor(
    private readonly s: string,
    private i: number,
  ) {}

  value(): unknown {
    this.skip()
    const c = this.s[this.i]
    if (c === '[') {
      this.i++
      const out: unknown[] = []
      while (!this.eat(']')) {
        out.push(this.value())
        if (!this.eat(',')) {
          this.expect(']')
          break
        }
      }
      return out
    }
    if (c === '{') {
      this.i++
      const out: Record<string, unknown> = {}
      while (!this.eat('}')) {
        const key = this.key()
        this.expect(':')
        out[key] = this.value()
        if (!this.eat(',')) {
          this.expect('}')
          break
        }
      }
      return out
    }
    if (c === "'" || c === '"' || c === '`') return this.string(c)
    const m = this.match(/true|false|null|-?\d+(?:\.\d+)?/y)
    if (m === null) throw new Error('not a literal')
    return JSON.parse(m)
  }

  private key(): string {
    this.skip()
    const c = this.s[this.i]
    if (c === "'" || c === '"') return this.string(c)
    const m = this.match(/[A-Za-z_$][\w$]*/y)
    if (m === null) throw new Error('not a key')
    return m
  }

  private string(q: string): string {
    let out = ''
    for (this.i++; this.i < this.s.length; this.i++) {
      const c = this.s[this.i]!
      if (c === q) {
        this.i++
        return out
      }
      if (c === '\\') out += this.s[++this.i]
      else if (q === '`' && c === '$' && this.s[this.i + 1] === '{') throw new Error('template')
      else out += c
    }
    throw new Error('unterminated')
  }

  private skip(): void {
    while (this.match(/\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\//y) !== null);
  }

  /** The sticky `re`'s match at the cursor, consumed; null when none. */
  private match(re: RegExp): string | null {
    re.lastIndex = this.i
    const m = re.exec(this.s)
    if (m === null || m[0] === '') return null
    this.i += m[0].length
    return m[0]
  }

  private eat(c: string): boolean {
    this.skip()
    if (this.s[this.i] !== c) return false
    this.i++
    return true
  }

  private expect(c: string): void {
    if (!this.eat(c)) throw new Error(`expected ${c}`)
  }
}
