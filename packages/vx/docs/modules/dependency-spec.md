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
  constructor(raw: string, message: string)
}

export function parseDependencySpec(raw: string): DependencySpec
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

`graph/task-graph.ts` rejects wildcards (`*`, `^*`) and negation in
`dependsOn` — those are filter-only. The parser doesn't know; it just
parses.

`orchestrator/upstream.ts` accepts every form because that's the
filter context. Last-write-wins ordering is applied there, not here.

## Tests

`tests/task-graph.test.ts` and `tests/orchestrator.test.ts` cover the
behaviors in their respective consumer contexts. The parser itself
is tested via the consumer tests (every grammar form is exercised
through `dependsOn` or `cache.inputs.tasks` use cases).
