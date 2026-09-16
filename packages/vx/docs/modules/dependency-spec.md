# `src/graph/dependency-spec.ts` — Turbo/Nx micro-syntax parser

## Purpose

Parse one entry from `dependsOn` or `cache.inputs.tasks` into a small
discriminated union. Pure — no FS, no project lookups. Caller-side
modules (`graph/task-graph.ts`, `orchestrator/upstream.ts`) decide
which kinds make semantic sense in their context.

## Public surface

```ts
export type DependencySpec =
  | { kind: 'self'; task: string; negated: boolean }
  | { kind: 'deps'; task: string; negated: boolean }
  | { kind: 'cross'; project: string; task: string; negated: boolean }
  | { kind: 'wildcardSelf'; negated: boolean } // '*'
  | { kind: 'wildcardDeps'; negated: boolean } // '^*'

export class DependencySpecError extends Error {
  readonly raw: string
  constructor(raw: string, message: string) // message: `Invalid dependency spec "<raw>": <message>`
}

export function parseDependencySpec(raw: string): DependencySpec

// A task name holding `*` is a PATTERN over task names (`build.*`, `check.*`):
export function isTaskPattern(task: string): boolean
export function compileTaskPattern(pattern: string): RegExp // `*` is any characters; anchored
```

## Grammar

| Form       | Result                                             |
| ---------- | -------------------------------------------------- |
| `name`     | `{ kind: 'self', task: name, negated: false }`     |
| `^name`    | `{ kind: 'deps', task: name, negated: false }`     |
| `pkg#task` | `{ kind: 'cross', project, task, negated: false }` |
| `*`        | `{ kind: 'wildcardSelf', negated: false }`         |
| `^*`       | `{ kind: 'wildcardDeps', negated: false }`         |
| `!<form>`  | Same kind as `<form>`, with `negated: true`        |

Errors:

- `''` (empty) → `empty spec`
- `'!'` (no body) → `negation with no body`
- `'^'` (no task) → `"^" with no task name`
- `'^pkg#task'` → `"^" cannot combine with "pkg#task" — pick one`
- `'#task'` / `'pkg#'` → `pkg#task requires a non-empty project AND task`

## Caller-side semantics

`graph/task-graph.ts` rejects the BARE wildcards (`*`, `^*`) and
negation in `dependsOn` — those are filter-only — and a pattern in
the `pkg#task` form. A partial pattern in the `self` and `deps` forms
(`build.*`, `^build.*`) is legal there: it names a namespace of tasks
to add (Nx 19.5 parity), every other same-project task matching it,
or the matching tasks of each dependency; zero matches is legal, since
a preset-spread pattern need not match in every project. The parser
does not know any of this; it parses, and `isTaskPattern` /
`compileTaskPattern` are what the consumers match with.

`orchestrator/upstream.ts` accepts every form because that's the
filter context. Last-write-wins ordering is applied there, not here.

## Tests

`tests/task-graph.test.ts`, `tests/wildcard-depends.test.ts` (the
partial patterns and the three refusals) and `tests/orchestrator.test.ts`
cover the behaviors in their respective consumer contexts. The parser
itself is tested via the consumer tests (every grammar form is
exercised through `dependsOn` or `cache.inputs.tasks` use cases).
