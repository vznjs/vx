// `vx lock --merge`, git's merge driver for the two locks (`merge=vx-lock`
// in `.vx/.gitattributes`, registered per clone by `vx init` and `vx lock`).
// Both locks are a header line, then one line per key, sorted: a project's
// name, and in the projects lock a `#id` task line too. Two branches that
// changed different projects merge line by line; one key both changed
// differently is a conflict, marked as git marks one, and the lock then
// refuses until `vx lock` rewrites it. A merged line is not proven: a run
// checks the merged digests against the merged dependency file
// (locked-digests.ts), and `vx lock --check` audits the configs.
//
// A merge, not a re-lock: the driver runs mid-merge, before the configs
// and the dependency file have merged, so evaluating them is not possible.
// GitHub's merge button runs no driver; there a conflict on the same
// project's line is git's own.

const PROJECTS = 'projects.lock.jsonl'

export interface MergedLock {
  text: string
  /** False when a key both sides changed differently is marked in `text`. */
  clean: boolean
}

interface Lines {
  header: string
  byKey: Map<string, string>
}

function lines(text: string): Lines {
  const all = text.split('\n')
  if (all.at(-1) === '') all.pop()
  const byKey = new Map<string, string>()
  for (let i = 1; i < all.length; i++) byKey.set(keyOf(all[i]!), all[i]!)
  return { header: all[0] ?? '', byKey }
}

/** A line's key: its name (a JSON string when a tab could break it) or `#id`. */
function keyOf(line: string): string {
  const tab = line.indexOf('\t')
  const raw = tab < 0 ? line : line.slice(0, tab)
  if (raw.charCodeAt(0) !== 34) return raw
  try {
    const name: unknown = JSON.parse(raw)
    return typeof name === 'string' ? name : raw
  } catch {
    return raw
  }
}

/** One side's change over the base wins; both alike is either; else a conflict. */
function pick(
  base: string | undefined,
  ours: string | undefined,
  theirs: string | undefined,
): { line: string | undefined } | null {
  if (ours === theirs || theirs === base) return { line: ours }
  if (ours === base) return { line: theirs }
  return null
}

function marked(ours: string | undefined, theirs: string | undefined): string[] {
  return [
    '<<<<<<< ours',
    ...(ours === undefined ? [] : [ours]),
    '=======',
    ...(theirs === undefined ? [] : [theirs]),
    '>>>>>>> theirs',
  ]
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** The dependencies lock's `files`, whose order its digests are in. */
function filesOf(header: string): string | undefined {
  try {
    return JSON.stringify((JSON.parse(header) as { files?: unknown }).files)
  } catch {
    return undefined
  }
}

/** The `#id` task lines a projects-lock line names. */
function taskRefs(line: string, into: Set<string>): void {
  try {
    const entry = JSON.parse(line.slice(line.indexOf('\t') + 1)) as {
      config?: { tasks?: Record<string, unknown> }
    }
    for (const ref of Object.values(entry.config?.tasks ?? {}))
      if (typeof ref === 'string') into.add(ref)
  } catch {}
}

/**
 * Merges three versions of a lock, `file` naming which (git's `%P`). The
 * dependencies lock's digests are in its header's `files` order, so two
 * sides that list other files conflict whole.
 */
export function mergeLock(file: string, base: string, ours: string, theirs: string): MergedLock {
  if (ours === theirs || theirs === base) return { text: ours, clean: true }
  if (ours === base) return { text: theirs, clean: true }
  const projects = file.endsWith(PROJECTS)
  const o = lines(base)
  const a = lines(ours)
  const b = lines(theirs)
  const header = pick(o.header, a.header, b.header)
  if (header === null || (!projects && filesOf(a.header) !== filesOf(b.header)))
    return { text: `${marked(ours.trimEnd(), theirs.trimEnd()).join('\n')}\n`, clean: false }
  let clean = true
  const out: [key: string, lines: string[]][] = []
  const keys = new Set([...a.byKey.keys(), ...b.byKey.keys()])
  for (const k of keys) {
    // Task lines are named by their content's hash: kept when a project names them.
    if (projects && k.charCodeAt(0) === 35) continue
    const got = pick(o.byKey.get(k), a.byKey.get(k), b.byKey.get(k))
    if (got === null) {
      clean = false
      out.push([k, marked(a.byKey.get(k), b.byKey.get(k))])
    } else if (got.line !== undefined) out.push([k, [got.line]])
  }
  out.sort((x, y) => cmp(x[0], y[0]))
  const body: string[] = []
  if (projects) {
    const refs = new Set<string>()
    for (const [, ls] of out) for (const l of ls) taskRefs(l, refs)
    for (const ref of [...refs].sort(cmp)) {
      const line = a.byKey.get(ref) ?? b.byKey.get(ref)
      if (line !== undefined) body.push(line)
    }
  }
  for (const [, ls] of out) body.push(...ls)
  return { text: `${[header.line ?? '', ...body].join('\n')}\n`, clean }
}
