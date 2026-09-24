// The toy monorepo the Learn widgets draw. The static render (the no-JS
// fallback) and the element that enhances it both read this one model, so
// the diagram, the tables and the highlighted sets cannot disagree about what
// depends on what, or about what a change reruns.

export interface ToyPackage {
  id: string
  /** The workspace packages its package.json depends on. */
  dependsOn: string[]
}

export const TOY_PACKAGES: ToyPackage[] = [
  { id: 'utils', dependsOn: [] },
  { id: 'ui', dependsOn: ['utils'] },
  { id: 'api', dependsOn: ['utils'] },
  { id: 'app', dependsOn: ['ui', 'api'] },
]

export interface ToyTask {
  /** `pkg#name`, the way Turborepo and vx spell a task. */
  id: string
  pkg: string
  name: 'build' | 'test'
  /** Task ids that must finish before this one starts. */
  dependsOn: string[]
}

/** Each package has the same two tasks, wired by the two rules most
 *  monorepos write: `build` depends on `^build` (the build of every package
 *  it depends on), and `test` depends on `build` (its own package's). */
export const TOY_TASKS: ToyTask[] = TOY_PACKAGES.flatMap((p): ToyTask[] => [
  {
    id: `${p.id}#build`,
    pkg: p.id,
    name: 'build',
    dependsOn: p.dependsOn.map((d) => `${d}#build`),
  },
  { id: `${p.id}#test`, pkg: p.id, name: 'test', dependsOn: [`${p.id}#build`] },
])

const byId = new Map(TOY_TASKS.map((t) => [t.id, t]))

/** The package and everything that depends on it, directly or through
 *  another package: the set a change to it affects. In model order. */
export function affectedBy(pkg: string): string[] {
  const affected = new Set([pkg])
  // A Set visits what is added during iteration, so this walks the closure.
  for (const current of affected) {
    for (const p of TOY_PACKAGES) if (p.dependsOn.includes(current)) affected.add(p.id)
  }
  return TOY_PACKAGES.map((p) => p.id).filter((p) => affected.has(p))
}

/** The tasks `--affected` selects when `pkg` changes: every task of every
 *  affected package. In model order. */
export function rerunBy(pkg: string): string[] {
  const affected = affectedBy(pkg)
  return TOY_TASKS.filter((t) => affected.includes(t.pkg)).map((t) => t.id)
}

/** The tasks the selected ones depend on that are not selected themselves.
 *  The run needs them first; nothing they read changed, so a cache that
 *  holds them restores them instead of running them. In model order. */
export function neededBy(pkg: string): string[] {
  const rerun = new Set(rerunBy(pkg))
  const needed = new Set<string>()
  const visit = (id: string): void => {
    for (const dep of byId.get(id)!.dependsOn) {
      if (rerun.has(dep) || needed.has(dep)) continue
      needed.add(dep)
      visit(dep)
    }
  }
  for (const id of rerun) visit(id)
  return TOY_TASKS.map((t) => t.id).filter((id) => needed.has(id))
}

/** The wave a task can start in: 1 for a task with no dependencies,
 *  otherwise one after the latest of its dependencies. Every task in a wave
 *  can run at the same time. */
export function waveOf(id: string): number {
  const deps = byId.get(id)!.dependsOn
  return deps.length === 0 ? 1 : 1 + Math.max(...deps.map(waveOf))
}

/** The given tasks grouped by wave, earliest first, each wave in model order. */
export function waves(ids: string[] = TOY_TASKS.map((t) => t.id)): string[][] {
  const byWave = new Map<number, string[]>()
  for (const t of TOY_TASKS) {
    if (!ids.includes(t.id)) continue
    const w = waveOf(t.id)
    byWave.set(w, [...(byWave.get(w) ?? []), t.id])
  }
  return [...byWave.keys()].sort((a, b) => a - b).map((w) => byWave.get(w)!)
}

/** `a`, `a and b`, `a, b and c`. */
export function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

// Caching (Learn: "Caching, from first principles"). What each task reads,
// what its key sees, and what a run with a cache does. A MODEL of vx's key
// fold, not the fold: the keys are digests computed here. What it must get
// right is which keys move, which tasks hit and which outputs are stale, and
// tests/key-model-core.test.ts holds exactly that against real vx runs over
// the same workspace.

/** Every package has this file; its build and its test read and declare it. */
export const TOY_SOURCE = 'src/index.ts'
/** Every build reads this file too. It is declared at first, and the reader
 *  can stop declaring it. */
const TOY_TSCONFIG = 'tsconfig.json'
/** The env var `api#build` bakes into its output, and the two values it takes. */
export const TOY_ENV = 'API_URL'
const TOY_ENV_VALUES = ['https://api.example.com', 'https://staging.example.com'] as const

/** Every input the reader can change: `<package>/<file>`, or the env var's name. */
export const TOY_INPUTS: string[] = [
  ...TOY_PACKAGES.flatMap((p) => [`${p.id}/${TOY_SOURCE}`, `${p.id}/${TOY_TSCONFIG}`]),
  TOY_ENV,
]

/** What a task reads, apart from the outputs of the tasks it depends on. This
 *  decides its output, whatever it declares. */
export function readsOf(taskId: string): string[] {
  const t = byId.get(taskId)!
  if (t.name === 'test') return [`${t.pkg}/${TOY_SOURCE}`]
  return [
    `${t.pkg}/${TOY_SOURCE}`,
    `${t.pkg}/${TOY_TSCONFIG}`,
    ...(t.pkg === 'api' ? [TOY_ENV] : []),
  ]
}

/** The one task that reads an input the reader may stop declaring. */
function readerOf(input: string): string {
  return TOY_TASKS.find((t) => t.name === 'build' && readsOf(t.id).includes(input))!.id
}

export interface ToyState {
  /** Inputs that no longer hold their first value: a file edited, the env var switched. */
  changed: readonly string[]
  /** Inputs the task that reads them does not declare. */
  undeclared: readonly string[]
}

export const TOY_START: ToyState = { changed: [], undeclared: [] }

/** Each change is a toggle: a second edit of a file undoes the first. */
export type ToyChange = { kind: 'edit'; input: string } | { kind: 'declare'; input: string }

export function applyChange(state: ToyState, change: ToyChange): ToyState {
  const flip = (list: readonly string[]): string[] =>
    list.includes(change.input) ? list.filter((i) => i !== change.input) : [...list, change.input]
  return change.kind === 'edit'
    ? { ...state, changed: flip(state.changed) }
    : { ...state, undeclared: flip(state.undeclared) }
}

/** The inputs a task's key sees: what it reads, less what it does not declare. */
export function declaredBy(state: ToyState, taskId: string): string[] {
  return readsOf(taskId).filter((i) => !state.undeclared.includes(i))
}

/** An input's content in a state: the env var's value, or which version of the file. */
export function valueOf(state: ToyState, input: string): string {
  const changed = state.changed.includes(input)
  if (input === TOY_ENV) return TOY_ENV_VALUES[changed ? 1 : 0]
  return `${input}@${changed ? 'edited' : 'first'}`
}

export interface ToyTaskRun {
  id: string
  /** The key this task had in the run before; undefined on the first run. */
  before: string | undefined
  key: string
  /** Why the key moved: something the task declares changed (`input`), or
   *  only the key of a task it depends on (`upstream`). Undefined if it did not. */
  moved: 'input' | 'upstream' | undefined
  hit: boolean
  /** Its output differs from what a run with no cache would produce now. */
  stale: boolean
}

export interface ToyRun {
  state: ToyState
  tasks: ToyTaskRun[]
  /** Every entry saved so far, key to output. A cache keeps old entries, so
   *  undoing an edit finds the entry the first version saved. */
  cache: ReadonlyMap<string, string>
  /** Per task, the digest of its key's own part: everything but upstream keys. */
  own: Readonly<Record<string, string>>
}

/** A 64-bit string digest (cyrb53's mixing, both halves kept) as 16 hex
 *  digits. Only equality matters here; it is not vx's xxHash3. */
export function digest(parts: readonly string[]): string {
  const s = parts.join('\0')
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/**
 * One run with a cache over `state`, after `prev` (or on an empty cache).
 * The key folds the task's id, the list of inputs it declares (that list is
 * config, and config is in the key), their values, and the keys of the tasks
 * it depends on. The output folds what the task READS and the outputs it
 * finds upstream. A hit replays the entry's output; a miss runs and saves.
 */
export function toyRun(state: ToyState, prev?: ToyRun): ToyRun {
  const cache = new Map(prev?.cache)
  const keys: Record<string, string> = {}
  const own: Record<string, string> = {}
  const outputs: Record<string, string> = {}
  const fresh: Record<string, string> = {}
  const tasks: ToyTaskRun[] = []
  // TOY_TASKS lists every task after the tasks it depends on.
  for (const t of TOY_TASKS) {
    const declared = declaredBy(state, t.id)
    const mine = digest([t.id, ...declared, '', ...declared.map((i) => valueOf(state, i))])
    own[t.id] = mine
    const key = digest([mine, ...t.dependsOn.map((d) => keys[d]!).sort()])
    keys[t.id] = key
    const read = readsOf(t.id).map((i) => valueOf(state, i))
    const output = (upstream: Record<string, string>): string =>
      digest([t.id, ...read, '', ...t.dependsOn.map((d) => upstream[d]!)])
    fresh[t.id] = output(fresh)
    const saved = cache.get(key)
    const produced = saved ?? output(outputs)
    outputs[t.id] = produced
    if (saved === undefined) cache.set(key, produced)
    const before = prev?.tasks.find((p) => p.id === t.id)?.key
    const moved =
      prev === undefined || before === key
        ? undefined
        : prev.own[t.id] !== mine
          ? 'input'
          : 'upstream'
    tasks.push({
      id: t.id,
      before,
      key,
      moved,
      hit: saved !== undefined,
      stale: produced !== fresh[t.id],
    })
  }
  return { state, tasks, cache, own }
}

/** The first run on an empty cache, then one run after each change. */
export function toyRuns(changes: readonly ToyChange[]): ToyRun[] {
  const runs = [toyRun(TOY_START)]
  for (const c of changes) {
    const last = runs.at(-1)!
    runs.push(toyRun(applyChange(last.state, c), last))
  }
  return runs
}

/** Seven hex digits, the way `git log --oneline` shortens a commit. */
export function shortKey(key: string): string {
  return key.slice(0, 7)
}

/** How the run treats a task, in the words the table uses. */
function outcomeOf(t: ToyTaskRun): string {
  if (t.hit) return t.stale ? 'stale hit' : 'hit'
  return t.stale ? 'runs, stale input' : 'runs'
}

/** One row of the calculator's table: the task, its key and how the run
 *  treats it. The static render and the element both use it. */
export function rowOf(t: ToyTaskRun): [string, string, string] {
  return [t.id, shortKey(t.key), outcomeOf(t)]
}

/** The same row as two words a stylesheet can select on. */
export function rowMarks(t: ToyTaskRun): { moved: string; outcome: string } {
  return {
    moved: t.moved ?? 'no',
    outcome: `${t.stale ? 'stale-' : ''}${t.hit ? 'hit' : 'run'}`,
  }
}

/** What a change does, in one sentence. `state` is the state it is made in. */
export function describeChange(change: ToyChange, state: ToyState): string {
  const undo = (change.kind === 'edit' ? state.changed : state.undeclared).includes(change.input)
  if (change.kind === 'declare') {
    const task = readerOf(change.input)
    return undo
      ? `${task} declares ${change.input} again.`
      : `${task} stops declaring ${change.input}, and still reads it.`
  }
  if (change.input === TOY_ENV) return `You set ${TOY_ENV} to ${TOY_ENV_VALUES[undo ? 0 : 1]}.`
  return undo ? `You undo your edit to ${change.input}.` : `You edit ${change.input}.`
}

/** What a run does, in counts: "4 run, 4 hit." */
export function runSummary(run: ToyRun): string {
  const n = (pick: (t: ToyTaskRun) => boolean): number => run.tasks.filter(pick).length
  const stale = n((t) => t.stale)
  return `${n((t) => !t.hit)} run, ${n((t) => t.hit)} hit.${stale === 0 ? '' : ` ${stale} stale.`}`
}

/** The four changes the page shows without JavaScript, one column each.
 *  Each starts from a first run on an empty cache. */
export const TOY_SCENARIOS: { id: string; title: string; changes: ToyChange[] }[] = [
  {
    id: 'utils',
    title: 'Edit utils',
    changes: [{ kind: 'edit', input: `utils/${TOY_SOURCE}` }],
  },
  {
    id: 'app',
    title: 'Edit app',
    changes: [{ kind: 'edit', input: `app/${TOY_SOURCE}` }],
  },
  {
    id: 'env',
    title: `Change ${TOY_ENV}`,
    changes: [{ kind: 'edit', input: TOY_ENV }],
  },
  {
    id: 'stale',
    title: 'Edit a file utils does not list',
    changes: [
      { kind: 'declare', input: `utils/${TOY_TSCONFIG}` },
      { kind: 'edit', input: `utils/${TOY_TSCONFIG}` },
    ],
  },
]
