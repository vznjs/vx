---
title: 'A glob that stops at the fence'
date: 2026-10-12T17:00:00Z
authors:
  - vzn
tags:
  - caching
  - correctness
excerpt: 'In a monorepo, projects nest. A root package that globs **/* would otherwise hash, and clean, every member under it. vx draws a fence at every nested project, so a key sees only its own project, and a change elsewhere reaches it only through a declared edge.'
---

The workspace root is a project here, and its task globs `**/*.ts`:

```ts
// vx.config.ts (workspace root)
count: {
  exec: { command: "find . -name '*.ts' -not -path './node_modules/*' | wc -l" },
  inputs: { files: ['**/*.ts'] },
  cache: { outputs: { files: [] } },
}
```

```sh frame="terminal"
$ echo "// e" >> packages/a/src/index.ts
$ vx run //#count
  cache     local 1✓

$ echo "// e" >> scripts/x.ts
$ vx run //#count
  cache     local 1↑

$ vx why //#count
  what changed (1 component, 6 unchanged):
    changed file  scripts/x.ts  fdfb0708… → b549282e…
```

An edit inside `packages/a` doesn't move the root's key, even though
`**/*.ts` matches it. A root file does. Demo workspace, vx at
`69617eb`, 2026-10-23.

A project's globs never reach into another project's directory.

## Why the fence

| Without it                               | What goes wrong                                    |
| ---------------------------------------- | -------------------------------------------------- |
| root inputs `**/*.ts`                    | every edit anywhere re-runs the root task          |
| root depends on members, no edge says so | `--affected` and the graph disagree with the cache |
| root outputs `**/*.js`                   | the pre-run wipe deletes members' files            |

vx wipes a task's declared outputs before every run and restore, so an
unfenced output glob is a delete across projects.

## How it works

Once per run, vx computes, for each project, the directories of the
projects nested under it (`workspace/nested-dirs.ts`). Every glob pass
drops a path under one of them, for inputs and for the output clean
alike. A workspace package counts as a project whether or not it has a
`vx.config.ts`, because `--affected` hands it its own files and its
default `build` keys them.

The nesting check is a sort and one scan, with a trap worth naming.
Sorted as strings, `foo`, `foo-utils` and `foo/nested` come out in that
order, because `-` sorts below `/`. A scan that stopped at the first
non-descendant would stop at `foo-utils` and never see `foo/nested`, so
the fence would silently have a hole. vx skips names that merely share
the prefix and stops only when it leaves the `foo` block.

## The one way across

If project A needs B's state, it says so with an edge: `dependsOn` B's
task. B's input key is then folded into A's, so an edit in B re-runs A,
and the graph, `--affected` and the cache all agree. That is the only
way one project's key moves when another project's files change.

With the sandbox on, the fence is enforced at run time too. A workspace
package reached through a `node_modules` link is visible to the task
only when its key folds a task of that package. Import a sibling the
key never sees and the read fails and is reported, instead of caching a
result an edit there would not re-run.

## The escape hatch

`inputs.workspaceFiles` and `cache.outputs.workspaceFiles` are
anchored at the workspace root and apply no fence. They exist for files
that genuinely belong to the root, like a shared `tsconfig.base.json`.
Reaching into another project's directory through them works, but it is
the side door again, so prefer an edge.

Details: [Caching, cross-project
boundaries](../../caching/#cross-project-boundaries). More at
[vznjs.github.io/vx](https://vznjs.github.io/vx/).
