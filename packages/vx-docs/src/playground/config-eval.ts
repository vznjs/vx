// The reader's `vx.config.mjs`, evaluated the way the CLI evaluates one
// (roadmap W9, item 699; design/playground-spike-2026-09.md § W9
// decisions).
//
// The text is a module: `rewriteConfigImports` points its `@vzn/vx` import
// at a module whose `defineProject` and `defineWorkspace` are the identity,
// as core's are, and refuses every other import. `evaluateConfig` imports
// the result from a Blob URL inside a Worker made from a Blob URL (a
// data:-URL worker has an opaque origin and cannot import a blob), so the
// reader's code never touches the page, and a deadline terminates a runaway.
//
// The default export crosses back as JSON, stringified in the worker and
// parsed here: the CLI's worker path (packages/vx/src/workspace/config-eval.ts,
// a repeat load) does the same, and the key folds `JSON.stringify` of the
// task config, so a value JSON drops (`undefined`, a function) is one the
// key never saw. A FIRST load in the CLI validates the live object instead,
// so a function where the schema wants a string is refused there and
// dropped here (design/playground-spike-2026-09.md § Shipped (item 699)).
//
// The refusal exists for its message, not as a boundary: from a Blob URL a
// browser resolves no other specifier anyway (a relative one has no base, a
// bare one no map), and says so less clearly.

const ONLY_VX = 'the playground evaluates a config on its own: it can import only @vzn/vx'

const VX_MODULE =
  'export const defineProject = (config) => config\nexport const defineWorkspace = (config) => config\n'

// Core's worker (config-eval.ts's WORKER_SRC), fed a URL instead of a path.
const WORKER = `
self.onmessage = async (e) => {
  try {
    const ns = await import(e.data)
    const mod = ns?.default
    postMessage({ ok: true, json: mod !== null && typeof mod === 'object' ? JSON.stringify(mod) : null })
  } catch (err) {
    postMessage({ ok: false, error: \`\${err?.name ?? 'Error'}: \${err?.message ?? String(err)}\` })
  }
}
`

/** What the CLI says of a config whose default export is not an object (project-loader.ts). */
export const NOT_AN_OBJECT = 'Project config at vx.config.mjs did not export a default object'

interface Token {
  kind: 'word' | 'string' | 'punct' | 'template' | 'regex'
  start: number
  end: number
  /**
   * A word's name, a punctuator's character, a string's contents between
   * its quotes, and a template piece's last character or two: `${` when
   * an expression follows.
   */
  value: string
}

// After one of these a `/` opens a regular expression, not a division.
const BEFORE_EXPRESSION = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

// Non-ASCII counts as an identifier's: a Unicode letter may start or continue one.
const isWord = (c: string): boolean => /[\w$]/.test(c) || c.charCodeAt(0) > 0x7f

/**
 * The module's tokens with comments and whitespace dropped, enough of
 * JavaScript's lexical grammar that a specifier in a string, a template,
 * a regular expression or a comment is not read as an import. A `/` after
 * `)` or `}` is read by the common case (a division after `)`, a
 * regular expression after `}`).
 */
function tokenize(src: string): Token[] {
  const out: Token[] = []
  // Brace depth at each open `${`, so its `}` resumes the template.
  const templates: number[] = []
  let depth = 0
  let i = 0
  const push = (kind: Token['kind'], start: number, end: number, value: string): void => {
    out.push({ kind, start, end, value })
    i = end
  }
  const template = (start: number): void => {
    let j = start
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') j += 2
      else if (src[j] === '$' && src[j + 1] === '{') {
        templates.push(++depth)
        push('template', start, j + 2, '${')
        return
      } else j++
    }
    push('template', start, Math.min(j + 1, src.length), '`')
  }
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i++
    } else if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
    } else if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      i = close === -1 ? src.length : close + 2
    } else if (c === '"' || c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      push('string', i, Math.min(j + 1, src.length), src.slice(i + 1, j))
    } else if (c === '`') {
      template(i + 1)
    } else if (c === '}' && templates.at(-1) === depth) {
      templates.pop()
      depth--
      template(i + 1)
    } else if (c === '/' && opensRegex(out.at(-1))) {
      let j = i + 1
      let inClass = false
      while (j < src.length && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        j++
      }
      j++
      while (j < src.length && isWord(src[j]!)) j++
      push('regex', i, Math.min(j, src.length), '')
    } else if (isWord(c)) {
      let j = i + 1
      while (j < src.length && isWord(src[j]!)) j++
      push('word', i, j, src.slice(i, j))
    } else {
      if (c === '{') depth++
      else if (c === '}') depth--
      push('punct', i, i + 1, c)
    }
  }
  return out
}

function opensRegex(prev: Token | undefined): boolean {
  if (prev === undefined) return true
  if (prev.kind === 'word') return BEFORE_EXPRESSION.has(prev.value)
  if (prev.kind === 'punct') return prev.value !== ')' && prev.value !== ']'
  return prev.kind === 'template' && prev.value === '${'
}

/**
 * Index of the specifier string of the `… from '<spec>'` clause whose
 * first token is at `first`, if the tokens are one.
 */
function fromClause(tokens: Token[], first: number): number | undefined {
  let braces = 0
  for (let j = first; j < tokens.length; j++) {
    const t = tokens[j]!
    const punct = t.kind === 'punct' ? t.value : undefined
    if (braces > 0) {
      if (punct === '}') braces--
      else if (punct !== undefined && punct !== ',') return undefined
      // `{ a }` without `from` is a local export, and nothing else may follow it.
      if (braces === 0 && !(tokens[j + 1]?.kind === 'word' && tokens[j + 1]!.value === 'from')) {
        return undefined
      }
    } else if (t.kind === 'word' && t.value === 'from' && tokens[j + 1]?.kind === 'string') {
      return j + 1
    } else if (punct === '{') braces++
    else if (t.kind !== 'word' && punct !== '*' && punct !== ',') return undefined
  }
  return undefined
}

/**
 * The specifier strings (token indices) of every import and re-export in
 * the module, or the refusal for one that is not a string literal.
 */
function importSpecifiers(tokens: Token[]): number[] | { error: string } {
  const found: number[] = []
  const at = (k: number): Token | undefined => tokens[k]
  const isPunct = (t: Token | undefined, v: string): boolean => t?.kind === 'punct' && t.value === v
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!
    if (t.kind !== 'word' || isPunct(at(k - 1), '.')) continue
    const next = at(k + 1)
    if (t.value === 'import') {
      if (isPunct(next, '(')) {
        const arg = at(k + 2)
        if (arg?.kind !== 'string' || !(isPunct(at(k + 3), ')') || isPunct(at(k + 3), ','))) {
          return { error: `cannot evaluate a computed import(): ${ONLY_VX}` }
        }
        found.push(k + 2)
      } else if (next?.kind === 'string') {
        found.push(k + 1)
      } else if (next?.kind === 'word' || isPunct(next, '{') || isPunct(next, '*')) {
        const spec = fromClause(tokens, k + 1)
        if (spec !== undefined) found.push(spec)
      }
    } else if (t.value === 'export' && (isPunct(next, '{') || isPunct(next, '*'))) {
      const spec = fromClause(tokens, k + 1)
      if (spec !== undefined) found.push(spec)
    }
  }
  return found
}

/**
 * The module text with each `@vzn/vx` specifier replaced by `vxUrl`, or
 * the refusal naming the first other import.
 */
export function rewriteConfigImports(
  text: string,
  vxUrl: string,
): { ok: true; text: string } | { ok: false; error: string } {
  const tokens = tokenize(text)
  const specs = importSpecifiers(tokens)
  if (!Array.isArray(specs)) return { ok: false, error: specs.error }
  let out = ''
  let from = 0
  for (const k of specs) {
    const t = tokens[k]!
    if (t.value !== '@vzn/vx') return { ok: false, error: `cannot import '${t.value}': ${ONLY_VX}` }
    out += text.slice(from, t.start) + JSON.stringify(vxUrl)
    from = t.end
  }
  return { ok: true, text: out + text.slice(from) }
}

type Reply = { ok: true; json: string | null } | { ok: false; error: string }

const moduleUrl = (source: string): string =>
  URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))

/**
 * Evaluate a `vx.config.mjs` text in a fresh Worker and return its default
 * export as the CLI's worker path hands it on, or the reason it has none.
 */
export async function evaluateConfig(
  text: string,
  deadlineMs: number,
): Promise<{ ok: true; config: unknown } | { ok: false; error: string }> {
  const vxUrl = moduleUrl(VX_MODULE)
  const urls = [vxUrl]
  try {
    const rewritten = rewriteConfigImports(text, vxUrl)
    if (!rewritten.ok) return rewritten
    const configUrl = moduleUrl(rewritten.text)
    const workerUrl = moduleUrl(WORKER)
    urls.push(configUrl, workerUrl)
    const worker = new Worker(workerUrl, { type: 'module' })
    const reply = await new Promise<Reply>((resolve) => {
      const timer = setTimeout(
        () =>
          resolve({
            ok: false,
            error: `the config did not finish evaluating within ${deadlineMs} ms`,
          }),
        deadlineMs,
      )
      worker.onmessage = (e: MessageEvent<Reply>) => {
        clearTimeout(timer)
        resolve(e.data)
      }
      // A throw from a callback the config scheduled (a timer's) reaches no
      // `catch` in the worker.
      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(timer)
        e.preventDefault()
        resolve({ ok: false, error: e.message })
      }
      worker.postMessage(configUrl)
    })
    worker.terminate()
    if (!reply.ok) return reply
    if (reply.json === null) return { ok: false, error: NOT_AN_OBJECT }
    return { ok: true, config: JSON.parse(reply.json) as unknown }
  } finally {
    for (const url of urls) URL.revokeObjectURL(url)
  }
}
